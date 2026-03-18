import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as zlib from 'node:zlib';
import { createArchiveWriter } from '@ismail-elkorchi/bytefold';
import { TarReader } from '@ismail-elkorchi/bytefold/tar';
import { ArchiveError, openArchive } from '@ismail-elkorchi/bytefold/node';

type NodeOpenOptions = NonNullable<Parameters<typeof openArchive>[1]>;

function allowLocalHttp(options: NodeOpenOptions): NodeOpenOptions {
  return {
    ...options,
    url: {
      ...(options.url ?? {}),
      allowHttp: true
    }
  };
}

function buildGzipPayload(size = 256 * 1024): Uint8Array {
  const source = new Uint8Array(size);
  let state = 0x12345678;
  for (let i = 0; i < source.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    source[i] = state & 0xff;
  }
  return zlib.gzipSync(source);
}

async function buildTarPayload(size = 4096): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const writer = createArchiveWriter('tar', writable);
  await writer.add('payload.bin', new Uint8Array(size).fill(0x61));
  await writer.close();
  return concatChunks(chunks);
}

test('shared response helper cancels oversized content-length bodies before throwing', async () => {
  const responseModuleUrl = pathToFileURL(path.join(process.cwd(), 'dist/streams/response.js')).href;
  const responseModule = (await import(responseModuleUrl)) as {
    readResponseBytes(response: Response, options?: { signal?: AbortSignal; maxBytes?: bigint | number }): Promise<Uint8Array>;
  };
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x61, 0x62, 0x63]));
    },
    cancel() {
      cancelled = true;
    }
  });
  const response = new Response(body, {
    status: 200,
    headers: { 'content-length': '1024' }
  });

  await assert.rejects(
    () => responseModule.readResponseBytes(response, { maxBytes: 64 }),
    (error: unknown) => error instanceof RangeError
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
});

test('node adapter: file full-buffer input honors maxInputBytes without reaching fetch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bytefold-node-input-'));
  const file = path.join(root, 'payload.gz');
  await writeFile(file, buildGzipPayload());
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  (globalThis as { fetch: typeof fetch }).fetch = async (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return originalFetch(...args);
  };

  try {
    await assert.rejects(
      async () => {
        await openArchive(file, { format: 'gz', limits: { maxInputBytes: 64 } });
      },
      (error: unknown) => error instanceof RangeError
    );
    assert.equal(fetchCalls, 0, 'local file path strings must not be classified as remote URLs');
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('node adapter: file URL inputs stay on local path reads and never fetch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bytefold-node-file-url-'));
  const file = path.join(root, 'payload.gz');
  await writeFile(file, buildGzipPayload());
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  (globalThis as { fetch: typeof fetch }).fetch = async (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return originalFetch(...args);
  };

  try {
    await assert.rejects(
      async () => {
        await openArchive(pathToFileURL(file), { format: 'gz', limits: { maxInputBytes: 64 } });
      },
      (error: unknown) => error instanceof RangeError
    );
    assert.equal(fetchCalls, 0, 'file: URL inputs must stay on the local file path branch');
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('node adapter: URL full fetch cancels slow responses once maxInputBytes is exceeded', async (t) => {
  const payload = buildGzipPayload();
  const chunkSize = 1024;
  const maxInputBytes = 512;
  let served = 0;

  const server = http.createServer((req, res) => {
    if (req.url !== '/payload.gz') {
      res.statusCode = 404;
      res.end();
      return;
    }

    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      const end = Math.min(offset + chunkSize, payload.length);
      const chunk = payload.subarray(offset, end);
      served += chunk.length;
      res.write(chunk);
      offset = end;
      if (offset >= payload.length) {
        clearInterval(timer);
        res.end();
      }
    }, 2);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/payload.gz`;

  await assert.rejects(
    async () => {
      await openArchive(url, { format: 'gz' });
    },
    (error: unknown) => error instanceof ArchiveError && error.code === 'ARCHIVE_UNSUPPORTED_FEATURE'
  );
  assert.equal(served, 0, 'http url inputs must reject before any transfer without opt-in');

  await assert.rejects(
    async () => {
      await openArchive(
        url,
        allowLocalHttp({
          format: 'gz',
          limits: { maxInputBytes }
        })
      );
    },
    (error: unknown) => error instanceof RangeError
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  const budget = maxInputBytes + chunkSize * 8;
  assert.ok(served <= budget, `expected bounded transfer <= ${budget}, received ${served}`);
});

test('TarReader.fromUrl honors content-length maxInputBytes before reading the body', async (t) => {
  const payload = await buildTarPayload();
  const chunkSize = 1024;

  const server = http.createServer((req, res) => {
    if (req.url !== '/payload.tar') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.writeHead(200, { 'content-length': String(payload.length) });
    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      const next = payload.subarray(offset, Math.min(offset + chunkSize, payload.length));
      if (next.length === 0) {
        clearInterval(timer);
        res.end();
        return;
      }
      offset += next.length;
      res.write(next);
    }, 2);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/payload.tar`;

  await assert.rejects(
    () => TarReader.fromUrl(url, { limits: { maxInputBytes: 64 } }),
    (error: unknown) => error instanceof RangeError
  );
});

test('TarReader.fromUrl cancels slow responses once maxInputBytes is exceeded', async (t) => {
  const payload = await buildTarPayload(16 * 1024);
  const chunkSize = 1024;
  const maxInputBytes = 512;
  let served = 0;

  const server = http.createServer((req, res) => {
    if (req.url !== '/payload.tar') {
      res.statusCode = 404;
      res.end();
      return;
    }

    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      const end = Math.min(offset + chunkSize, payload.length);
      const chunk = payload.subarray(offset, end);
      served += chunk.length;
      res.write(chunk);
      offset = end;
      if (offset >= payload.length) {
        clearInterval(timer);
        res.end();
      }
    }, 2);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/payload.tar`;

  await assert.rejects(
    () => TarReader.fromUrl(url, { limits: { maxInputBytes } }),
    (error: unknown) => error instanceof RangeError
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  const budget = maxInputBytes + chunkSize * 8;
  assert.ok(served <= budget, `expected bounded transfer <= ${budget}, received ${served}`);
});

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
