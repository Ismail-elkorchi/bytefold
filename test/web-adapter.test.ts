import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createArchiveWriter, openArchive } from '@ismail-elkorchi/bytefold/web';

const encoder = new TextEncoder();
const ZIP_BUDGET_DIVISOR = 16;
const ZIP_READ_BLOCK_SIZE = 64 * 1024;

class CountingBlob extends Blob {
  sliceCalls = 0;
  slicedBytes = 0;
  fullReads = 0;

  override slice(start?: number, end?: number, contentType?: string): Blob {
    const normalizedStart = Math.max(0, Number(start ?? 0));
    const normalizedEnd = Math.max(normalizedStart, Number(end ?? this.size));
    const boundedStart = Math.min(this.size, normalizedStart);
    const boundedEnd = Math.min(this.size, normalizedEnd);
    this.sliceCalls += 1;
    this.slicedBytes += Math.max(0, boundedEnd - boundedStart);
    return super.slice(start, end, contentType);
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.fullReads += 1;
    return super.arrayBuffer();
  }
}

test('web adapter: openArchive(Blob zip) is seekable and bounded', async () => {
  const zipBytes = await buildZipFixture();
  const blob = new CountingBlob([blobPartFromBytes(zipBytes)], { type: 'application/zip' });

  const archive = await openArchive(blob, { format: 'zip' });
  assert.equal(archive.format, 'zip');
  assert.equal(archive.detection?.inputKind, 'blob');

  const names: string[] = [];
  let smallPayload = '';
  for await (const entry of archive.entries()) {
    names.push(entry.name);
    if (entry.name === 'small.txt') {
      const bytes = await collect(await entry.open());
      smallPayload = new TextDecoder().decode(bytes);
    }
  }

  assert.deepEqual(names.sort(), ['big.bin', 'small.txt']);
  assert.equal(smallPayload, 'bytefold-web-small');

  const budget = Math.ceil(blob.size / ZIP_BUDGET_DIVISOR);
  const requestBudget = 1 + Math.ceil(budget / ZIP_READ_BLOCK_SIZE) + 4;
  assert.equal(blob.fullReads, 0, 'expected no full Blob arrayBuffer reads');
  assert.ok(blob.sliceCalls > 0, 'expected seekable blob slice reads');
  assert.ok(blob.slicedBytes > 0, 'expected non-zero sliced bytes');
  assert.ok(blob.slicedBytes <= budget, `blob read bytes ${blob.slicedBytes} exceeded budget ${budget}`);
  assert.ok(blob.sliceCalls <= requestBudget, `blob read calls ${blob.sliceCalls} exceeded budget ${requestBudget}`);
});

test('web adapter: openArchive(Blob gz) works end-to-end', async () => {
  const gzBytes = await buildGzipFixture('hello.txt', 'hello from blob');
  const archive = await openArchive(new Blob([blobPartFromBytes(gzBytes)], { type: 'application/gzip' }), {
    filename: 'hello.txt.gz'
  });

  assert.equal(archive.format, 'gz');
  assert.equal(archive.detection?.inputKind, 'blob');

  const entries: Array<{ name: string; body: string }> = [];
  for await (const entry of archive.entries()) {
    const payload = await collect(await entry.open());
    entries.push({ name: entry.name, body: new TextDecoder().decode(payload) });
  }

  assert.deepEqual(entries, [{ name: 'hello.txt', body: 'hello from blob' }]);
});

test('web adapter: URL input uses full fetch without range requests', async () => {
  const zipBytes = await buildZipFixture();
  const seenRanges: string[] = [];

  const server = http.createServer((req, res) => {
    if (req.headers.range) {
      seenRanges.push(String(req.headers.range));
      res.statusCode = 400;
      res.end('range not supported in web adapter');
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-length', String(zipBytes.length));
    res.end(zipBytes);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to resolve server address');
    }
    const url = `http://127.0.0.1:${address.port}/fixture.zip`;
    const archive = await openArchive(url, { format: 'zip' });
    assert.equal(archive.detection?.inputKind, 'url');
    const names: string[] = [];
    for await (const entry of archive.entries()) {
      names.push(entry.name);
    }
    assert.deepEqual(names.sort(), ['big.bin', 'small.txt']);
  } finally {
    server.close();
  }

  assert.deepEqual(seenRanges, [], 'web adapter should not send Range headers');
});

test('web adapter: URL full fetch honors maxInputBytes limit', async () => {
  const zipBytes = await buildZipFixture();
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-length', String(zipBytes.length));
    res.end(zipBytes);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to resolve server address');
    }
    const url = `http://127.0.0.1:${address.port}/fixture.zip`;
    await assert.rejects(
      () =>
        openArchive(url, {
          format: 'zip',
          limits: { maxInputBytes: 64 }
        }),
      (err: unknown) => err instanceof RangeError
    );
  } finally {
    server.close();
  }
});

test('web adapter: URL full fetch aborts slow responses once maxInputBytes is exceeded', async () => {
  const body = buildPatternBytes(3 * 1024 * 1024);
  const maxInputBytes = 8 * 1024;
  const chunkSize = 1024;
  const stats = {
    bytesServed: 0,
    requests: 0,
    rangeHeaders: [] as string[],
    clientClosed: false
  };

  const server = http.createServer((req, res) => {
    stats.requests += 1;
    if (req.headers.range) {
      stats.rangeHeaders.push(String(req.headers.range));
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/zip');

    let offset = 0;
    const timer = setInterval(() => {
      if (req.destroyed || req.socket.destroyed || res.destroyed || res.writableEnded) {
        clearInterval(timer);
        return;
      }
      if (offset >= body.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      const end = Math.min(offset + chunkSize, body.length);
      const chunk = body.subarray(offset, end);
      stats.bytesServed += chunk.length;
      res.write(chunk);
      offset = end;
    }, 2);

    req.on('close', () => {
      stats.clientClosed = true;
      clearInterval(timer);
    });
    res.on('close', () => {
      clearInterval(timer);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to resolve server address');
    }
    const url = `http://127.0.0.1:${address.port}/slow-fixture.zip`;
    await assert.rejects(
      () =>
        openArchive(url, {
          format: 'zip',
          limits: { maxInputBytes }
        }),
      (err: unknown) => err instanceof RangeError
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    server.close();
  }

  assert.equal(stats.requests, 1, 'expected a single URL fetch');
  assert.deepEqual(stats.rangeHeaders, [], 'web adapter should not send Range headers');
  assert.equal(stats.clientClosed, true, 'expected client connection to close after limit rejection');
  const budget = maxInputBytes + chunkSize * 2;
  assert.ok(stats.bytesServed <= budget, `served bytes ${stats.bytesServed} exceeded budget ${budget}`);
  assert.ok(stats.bytesServed < body.length, 'server should not stream the full body after limit rejection');
});

async function buildZipFixture(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });

  const writer = createArchiveWriter('zip', writable);
  await writer.add('small.txt', encoder.encode('bytefold-web-small'));
  await writer.add('big.bin', buildPatternBytes(4 * 1024 * 1024));
  await writer.close();
  return concatChunks(chunks);
}

async function buildGzipFixture(name: string, payload: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('gz', writable);
  await writer.add(name, encoder.encode(payload));
  await writer.close();
  return concatChunks(chunks);
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatChunks(chunks);
}

function buildPatternBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  let state = 0x9e37_79b9;
  for (let i = 0; i < size; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function blobPartFromBytes(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  return owned.buffer;
}
