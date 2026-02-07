import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { openArchive } from '@ismail-elkorchi/bytefold/node';
import { createDecompressor } from '@ismail-elkorchi/bytefold/compress';

const FIXTURE_ROOT = new URL('../test/fixtures/', import.meta.url);

test('xz multi-byte VLI parsing survives chunk boundaries', async () => {
  const bytes = new Uint8Array(await readFile(new URL('xz-vli/vli-uncompressed-128.xz', FIXTURE_ROOT)));
  const expected = new Uint8Array(await readFile(new URL('xz-vli/vli-uncompressed-128.bin', FIXTURE_ROOT)));
  const { indexStart, uncompressedStart, uncompressedLength } = locateUncompressedVli(bytes);
  assert.ok(uncompressedLength > 1, 'expected multi-byte uncompressed VLI');

  const boundaries: number[] = [];
  for (let i = 1; i < uncompressedLength; i += 1) {
    boundaries.push(indexStart + uncompressedStart + i);
  }
  const sizes = sizesFromBoundaries(bytes.length, boundaries);
  const output = await decompressWithChunks(bytes, sizes);
  assert.deepEqual(output, expected);
});

test('xz multi-byte VLI preflight stays bounded over HTTP range', async (t) => {
  const bytes = new Uint8Array(await readFile(new URL('xz-vli/vli-uncompressed-128.xz', FIXTURE_ROOT)));
  const expected = new Uint8Array(await readFile(new URL('xz-vli/vli-uncompressed-128.bin', FIXTURE_ROOT)));
  const { server, stats } = await startRangeServer(bytes);
  t.after(() => server.close());

  const reader = await openArchive(serverUrl(server, 'xz-vli/vli-uncompressed-128.xz'), {
    format: 'xz',
    limits: { maxXzPreflightBlockHeaders: 1 }
  });
  let payload: Uint8Array | null = null;
  for await (const entry of reader.entries()) {
    payload = await collect(await entry.open());
  }
  assert.ok(payload, 'missing payload');
  assert.deepEqual(payload, expected);

  const expectedRanges = expectedTailRanges(bytes.length, 32 * 1024, 32 * 1024);
  const headRange = `bytes=0-${Math.min(32 * 1024 - 1, bytes.length - 1)}`;
  const expectedRangeList = [...expectedRanges, headRange];
  assert.deepEqual(stats.ranges, expectedRangeList);
  const expectedRangeBytes = sumRangeBytes(expectedRangeList);
  assert.equal(stats.rangeBytes, expectedRangeBytes);
  assert.equal(stats.bytes, expectedRangeBytes + bytes.length);
  assert.equal(stats.requests, expectedRangeList.length + 2);
  assert.ok(stats.rangeBytes < bytes.length, 'expected preflight range bytes < full file');
});

function locateUncompressedVli(bytes: Uint8Array): {
  indexStart: number;
  uncompressedStart: number;
  uncompressedLength: number;
} {
  if (bytes.length < 12) throw new Error('XZ stream too small');
  const footer = bytes.subarray(bytes.length - 12);
  const backwardSize = readUint32LE(footer, 4);
  const indexSize = (backwardSize + 1) * 4;
  const indexStart = bytes.length - 12 - indexSize;
  if (indexStart < 0) throw new Error('invalid index start');
  const index = bytes.subarray(indexStart, indexStart + indexSize);
  if (index[0] !== 0x00) throw new Error('invalid index indicator');
  let offset = 1;
  const recordCount = readVli(index, offset);
  if (!recordCount) throw new Error('missing record count');
  offset = recordCount.offset;
  const unpadded = readVli(index, offset);
  if (!unpadded) throw new Error('missing unpadded size');
  offset = unpadded.offset;
  const uncompressedStart = offset;
  const uncompressed = readVli(index, offset);
  if (!uncompressed) throw new Error('missing uncompressed size');
  const uncompressedLength = uncompressed.offset - uncompressedStart;
  return { indexStart, uncompressedStart, uncompressedLength };
}

function readVli(buffer: Uint8Array, start: number): { value: bigint; offset: number } | null {
  let offset = start;
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < 9; i += 1) {
    if (offset >= buffer.length) return null;
    const byte = buffer[offset++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  return null;
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
  return (
    buffer[offset]! |
    (buffer[offset + 1]! << 8) |
    (buffer[offset + 2]! << 16) |
    (buffer[offset + 3]! << 24)
  ) >>> 0;
}

function sizesFromBoundaries(total: number, boundaries: number[]): number[] {
  const cuts = boundaries.filter((value) => value > 0 && value < total).sort((a, b) => a - b);
  const sizes: number[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut === cursor) continue;
    sizes.push(cut - cursor);
    cursor = cut;
  }
  if (cursor < total) sizes.push(total - cursor);
  return sizes;
}

async function decompressWithChunks(bytes: Uint8Array, sizes: number[]): Promise<Uint8Array> {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      for (const size of sizes) {
        const end = Math.min(bytes.length, offset + size);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      }
      controller.close();
    }
  });
  const transform = createDecompressor({ algorithm: 'xz' });
  const stream = readable.pipeThrough(transform);
  return collect(stream);
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
  return concatBytes(chunks);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

type ServerStats = { bytes: number; rangeBytes: number; requests: number; ranges: string[] };

function startRangeServer(data: Uint8Array): Promise<{ server: http.Server; stats: ServerStats }> {
  const stats: ServerStats = { bytes: 0, rangeBytes: 0, requests: 0, ranges: [] };
  const server = http.createServer((req, res) => {
    stats.requests += 1;
    if (req.method === 'HEAD') {
      res.statusCode = 200;
      res.setHeader('Content-Length', data.length);
      res.end();
      return;
    }
    const range = req.headers.range;
    if (typeof range === 'string') {
      stats.ranges.push(range);
      const match = /^bytes=(\d+)-(\d+)?$/.exec(range);
      if (!match) {
        res.statusCode = 416;
        res.end();
        return;
      }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : data.length - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= data.length) {
        res.statusCode = 416;
        res.end();
        return;
      }
      const safeEnd = Math.min(end, data.length - 1);
      const body = data.subarray(start, safeEnd + 1);
      res.statusCode = 206;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${data.length}`);
      res.setHeader('Content-Length', body.length);
      stats.bytes += body.length;
      stats.rangeBytes += body.length;
      res.end(body);
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Length', data.length);
    stats.bytes += data.length;
    res.end(data);
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, stats }));
  });
}

function serverUrl(server: http.Server, suffix: string): string {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/${suffix}`;
}

function expectedTailRanges(size: number, blockSize: number, tailSize: number): string[] {
  const start = size - tailSize;
  if (start < 0) {
    if (size <= 0) return [];
    return [`bytes=0-${size - 1}`];
  }
  const startBlock = Math.floor(start / blockSize) * blockSize;
  const endOffset = size - 1;
  const endBlock = Math.floor(endOffset / blockSize) * blockSize;
  if (startBlock === endBlock) {
    return [`bytes=${startBlock}-${endOffset}`];
  }
  const firstEnd = Math.min(startBlock + blockSize - 1, endOffset);
  const ranges = [`bytes=${startBlock}-${firstEnd}`];
  for (let block = startBlock + blockSize; block <= endBlock; block += blockSize) {
    const end = Math.min(block + blockSize - 1, endOffset);
    ranges.push(`bytes=${block}-${end}`);
  }
  return ranges;
}

function sumRangeBytes(ranges: string[]): number {
  let total = 0;
  for (const range of ranges) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    total += end - start + 1;
  }
  return total;
}
