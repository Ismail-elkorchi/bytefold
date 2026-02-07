import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { openArchive, ArchiveError } from '@ismail-elkorchi/bytefold/node';
import { CompressionError } from '@ismail-elkorchi/bytefold/compress';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const FIXTURE_ROOT = new URL('../test/fixtures/', import.meta.url);
const ERROR_SCHEMA = new URL('../schemas/error.schema.json', import.meta.url);

type ServerStats = { bytes: number; rangeBytes: number; requests: number; ranges: string[] };

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

function startRangeServer(data: Uint8Array, supportRange: boolean): Promise<{ server: http.Server; stats: ServerStats }> {
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
    if (supportRange && typeof range === 'string') {
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

async function loadSchema(): Promise<JsonSchema> {
  return (JSON.parse(await readFile(ERROR_SCHEMA, 'utf8')) as unknown) as JsonSchema;
}

test('xz seekable preflight fails fast for index byte limit', async (t) => {
  const bytes = new Uint8Array(await readFile(new URL('concat-two.xz', FIXTURE_ROOT)));
  const { server, stats } = await startRangeServer(bytes, true);
  t.after(() => server.close());

  const errorSchema = await loadSchema();
  await assert.rejects(
    () => openArchive(serverUrl(server, 'concat-two.xz'), { format: 'xz', limits: { maxXzIndexBytes: 1 } }),
    (err: unknown) => {
      if (!(err instanceof CompressionError)) return false;
      assert.equal(err.code, 'COMPRESSION_RESOURCE_LIMIT');
      const json = err.toJSON();
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      return true;
    }
  );

  assert.equal(stats.requests, 2);
  assert.equal(stats.bytes, bytes.length);
});

test('xz seekable preflight fails fast for index record limit', async (t) => {
  const bytes = new Uint8Array(await readFile(new URL('concat-two.xz', FIXTURE_ROOT)));
  const { server, stats } = await startRangeServer(bytes, true);
  t.after(() => server.close());

  const errorSchema = await loadSchema();
  await assert.rejects(
    () => openArchive(serverUrl(server, 'concat-two.xz'), { format: 'xz', limits: { maxXzIndexRecords: 1 } }),
    (err: unknown) => {
      if (!(err instanceof CompressionError)) return false;
      assert.equal(err.code, 'COMPRESSION_RESOURCE_LIMIT');
      const json = err.toJSON();
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      return true;
    }
  );

  assert.equal(stats.requests, 2);
  assert.equal(stats.bytes, bytes.length);
});

test('xz seekable preflight fails fast for dictionary limit', async (t) => {
  const bytes = new Uint8Array(await readFile(new URL('xz-dict-huge.xz', FIXTURE_ROOT)));
  assert.ok(bytes.length > 4 * 1024 * 1024, 'expected large xz fixture');
  const { server, stats } = await startRangeServer(bytes, true);
  t.after(() => server.close());

  const errorSchema = await loadSchema();
  await assert.rejects(
    () => openArchive(serverUrl(server, 'xz-dict-huge.xz'), { format: 'xz', limits: { maxXzDictionaryBytes: 1024 } }),
    (err: unknown) => {
      if (!(err instanceof CompressionError)) return false;
      assert.equal(err.code, 'COMPRESSION_RESOURCE_LIMIT');
      const json = err.toJSON();
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      const context = (json as { context?: Record<string, string> }).context;
      assert.ok(context?.requiredDictionaryBytes);
      assert.ok(context?.limitDictionaryBytes);
      return true;
    }
  );

  assert.ok(stats.bytes < 64 * 1024, `expected bounded bytes, got ${stats.bytes}`);
  assert.ok(stats.ranges.length > 0, 'expected range requests');
  const expectedRanges = expectedTailRanges(bytes.length, 32 * 1024, 32 * 1024);
  assert.deepEqual(stats.ranges, expectedRanges);
  assert.equal(stats.requests, expectedRanges.length + 1);
});

test('xz seekable preflight parses BCJ block headers', async (t) => {
  const bytes = new Uint8Array(await readFile(new URL('xz-bcj/x86.xz', FIXTURE_ROOT)));
  const { server, stats } = await startRangeServer(bytes, true);
  t.after(() => server.close());

  const errorSchema = await loadSchema();
  await assert.rejects(
    () => openArchive(serverUrl(server, 'xz-bcj/x86.xz'), { format: 'xz', limits: { maxXzDictionaryBytes: 1024 } }),
    (err: unknown) => {
      if (!(err instanceof CompressionError)) return false;
      assert.equal(err.code, 'COMPRESSION_RESOURCE_LIMIT');
      const json = err.toJSON();
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      const context = (json as { context?: Record<string, string> }).context;
      assert.ok(context?.requiredDictionaryBytes);
      assert.ok(context?.limitDictionaryBytes);
      return true;
    }
  );

  assert.ok(stats.ranges.length > 0, 'expected range requests');
  assert.ok(stats.bytes <= bytes.length, `expected bounded bytes, got ${stats.bytes}`);
});

test('xz seekable preflight parses mixed filter block headers', async (t) => {
  const bytes = new Uint8Array(await readFile(new URL('xz-mixed/delta-x86-lzma2.xz', FIXTURE_ROOT)));
  const { server, stats } = await startRangeServer(bytes, true);
  t.after(() => server.close());

  const errorSchema = await loadSchema();
  await assert.rejects(
    () =>
      openArchive(serverUrl(server, 'xz-mixed/delta-x86-lzma2.xz'), {
        format: 'xz',
        limits: { maxXzDictionaryBytes: 1024 }
      }),
    (err: unknown) => {
      if (!(err instanceof CompressionError)) return false;
      assert.equal(err.code, 'COMPRESSION_RESOURCE_LIMIT');
      const json = err.toJSON();
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      const context = (json as { context?: Record<string, string> }).context;
      assert.ok(context?.requiredDictionaryBytes);
      assert.ok(context?.limitDictionaryBytes);
      return true;
    }
  );

  assert.ok(stats.ranges.length > 0, 'expected range requests');
  assert.ok(stats.bytes <= bytes.length, `expected bounded bytes, got ${stats.bytes}`);
});

test('xz seekable preflight success path stays bounded', async (t) => {
  const bytes = new Uint8Array(await readFile(new URL('hello.txt.xz', FIXTURE_ROOT)));
  const { server, stats } = await startRangeServer(bytes, true);
  t.after(() => server.close());

  const reader = await openArchive(serverUrl(server, 'hello.txt.xz'), {
    format: 'xz',
    limits: { maxXzPreflightBlockHeaders: 1 }
  });
  let sawEntry = false;
  for await (const entry of reader.entries()) {
    const data = await collect(await entry.open());
    const text = new TextDecoder().decode(data);
    assert.equal(text, 'hello from bytefold\n');
    sawEntry = true;
  }
  assert.ok(sawEntry, 'expected entry from hello.txt.xz');

  const report = await reader.audit();
  const incomplete = report.issues.find((entry) => entry.code === 'COMPRESSION_RESOURCE_PREFLIGHT_INCOMPLETE');
  assert.equal(incomplete, undefined);

  const expectedRanges = expectedTailRanges(bytes.length, 32 * 1024, 32 * 1024);
  assert.deepEqual(stats.ranges, expectedRanges);
  const expectedRangeBytes = sumRangeBytes(expectedRanges);
  assert.equal(stats.rangeBytes, expectedRangeBytes);
  assert.equal(stats.bytes, expectedRangeBytes + bytes.length);
  assert.equal(stats.requests, expectedRanges.length + 2);
});

test('xz seekable preflight reports incomplete when block header limit is exceeded', async () => {
  const fileUrl = new URL('concat-two.xz', FIXTURE_ROOT);
  const reader = await openArchive(fileUrl, { format: 'xz', limits: { maxXzPreflightBlockHeaders: 0 } });
  const report = await reader.audit();
  const issue = report.issues.find((entry) => entry.code === 'COMPRESSION_RESOURCE_PREFLIGHT_INCOMPLETE');
  assert.ok(issue, 'missing preflight incomplete issue');
  assert.equal(issue?.severity, 'info');
  const details = issue?.details as Record<string, string> | undefined;
  assert.equal(details?.requiredBlockHeaders, '1');
  assert.equal(details?.limitBlockHeaders, '0');
});

test('xz seekable preflight stops after max block headers', async (t) => {
  const bytes = new Uint8Array(await readFile(new URL('xz-many-blocks/many-blocks.xz', FIXTURE_ROOT)));
  const expected = new Uint8Array(await readFile(new URL('xz-many-blocks/many-blocks.bin', FIXTURE_ROOT)));
  const { server, stats } = await startRangeServer(bytes, true);
  t.after(() => server.close());

  const reader = await openArchive(serverUrl(server, 'xz-many-blocks/many-blocks.xz'), {
    format: 'xz',
    limits: { maxXzPreflightBlockHeaders: 1 }
  });
  let payload: Uint8Array | null = null;
  for await (const entry of reader.entries()) {
    payload = await collect(await entry.open());
  }
  assert.ok(payload, 'missing payload from many-block fixture');
  assert.deepEqual(payload, expected);

  const report = await reader.audit();
  const incomplete = report.issues.find((entry) => entry.code === 'COMPRESSION_RESOURCE_PREFLIGHT_INCOMPLETE');
  assert.ok(incomplete, 'expected preflight incomplete issue');
  const details = incomplete?.details as Record<string, string> | undefined;
  assert.equal(details?.requiredBlockHeaders, '5');
  assert.equal(details?.limitBlockHeaders, '1');

  const tailRanges = expectedTailRanges(bytes.length, 32 * 1024, 32 * 1024);
  const headRange = `bytes=0-${Math.min(32 * 1024 - 1, bytes.length - 1)}`;
  const expectedRanges = [...tailRanges, headRange];
  assert.deepEqual(stats.ranges, expectedRanges);
  const expectedRangeBytes = sumRangeBytes(expectedRanges);
  assert.equal(stats.rangeBytes, expectedRangeBytes);
  assert.equal(stats.requests, expectedRanges.length + 2);
  assert.ok(stats.bytes <= expectedRangeBytes + bytes.length);
});

test('xz seekable preflight requires HTTP range support', async (t) => {
  const bytes = new Uint8Array(await readFile(new URL('concat-two.xz', FIXTURE_ROOT)));
  const { server } = await startRangeServer(bytes, false);
  t.after(() => server.close());

  const errorSchema = await loadSchema();
  await assert.rejects(
    () => openArchive(serverUrl(server, 'concat-two.xz'), { format: 'xz', limits: { maxXzIndexRecords: 1 } }),
    (err: unknown) => {
      if (!(err instanceof ArchiveError)) return false;
      assert.equal(err.code, 'ARCHIVE_HTTP_RANGE_UNSUPPORTED');
      const json = err.toJSON();
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      return true;
    }
  );
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
