import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { openArchive } from '@ismail-elkorchi/bytefold/node';
import { ZipError } from '@ismail-elkorchi/bytefold/zip';
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

test('zip seekable preflight success stays bounded over HTTP range', async (t) => {
  const bytes = new Uint8Array(await readFile(new URL('zip-preflight/basic.zip', FIXTURE_ROOT)));
  const { server, stats } = await startRangeServer(bytes, true);
  t.after(() => server.close());

  const reader = await openArchive(serverUrl(server, 'basic.zip'), { format: 'zip' });
  assert.equal(reader.format, 'zip');
  const entries: string[] = [];
  for await (const entry of reader.entries()) {
    entries.push(entry.name);
  }
  assert.deepEqual(entries, ['hello.txt']);

  const expectedRanges = expectedTailRanges(bytes.length, 32 * 1024, Math.min(bytes.length, 0x10000 + 22));
  assert.deepEqual(stats.ranges, expectedRanges);
  assert.equal(stats.rangeBytes, sumRangeBytes(expectedRanges));
  assert.equal(stats.bytes, stats.rangeBytes);
  assert.equal(stats.requests, expectedRanges.length + 1);
});

test('zip seekable preflight fails fast for central directory limit', async (t) => {
  const bytes = new Uint8Array(await readFile(new URL('zip-preflight/basic.zip', FIXTURE_ROOT)));
  const { server, stats } = await startRangeServer(bytes, true);
  t.after(() => server.close());

  const errorSchema = await loadSchema();
  await assert.rejects(
    () => openArchive(serverUrl(server, 'basic.zip'), { format: 'zip', limits: { maxZipCentralDirectoryBytes: 1 } }),
    (err: unknown) => {
      if (!(err instanceof ZipError)) return false;
      assert.equal(err.code, 'ZIP_LIMIT_EXCEEDED');
      const json = err.toJSON();
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      return true;
    }
  );

  assert.ok(stats.rangeBytes <= bytes.length);
  assert.equal(stats.bytes, stats.rangeBytes);
  assert.ok(stats.ranges.length > 0);
});

test('zip seekable preflight enforces EOCD search window limit', async (t) => {
  const bytes = new Uint8Array(await readFile(new URL('zip-preflight/basic.zip', FIXTURE_ROOT)));
  const { server, stats } = await startRangeServer(bytes, true);
  t.after(() => server.close());

  const errorSchema = await loadSchema();
  await assert.rejects(
    () => openArchive(serverUrl(server, 'basic.zip'), { format: 'zip', limits: { maxZipEocdSearchBytes: 10 } }),
    (err: unknown) => {
      if (!(err instanceof ZipError)) return false;
      assert.equal(err.code, 'ZIP_LIMIT_EXCEEDED');
      const json = err.toJSON();
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      return true;
    }
  );

  assert.equal(stats.bytes, 0);
  assert.equal(stats.rangeBytes, 0);
  assert.equal(stats.requests, 1);
  assert.equal(stats.ranges.length, 0);
});

test('zip seekable preflight supports zip64 over URL and file path', async (t) => {
  const bytes = new Uint8Array(await readFile(new URL('thirdparty/zip/zip64.zip', FIXTURE_ROOT)));
  const { server, stats } = await startRangeServer(bytes, true);
  t.after(() => server.close());

  const reader = await openArchive(serverUrl(server, 'zip64.zip'), { format: 'zip' });
  assert.equal(reader.format, 'zip');
  let count = 0;
  for await (const entry of reader.entries()) {
    count += 1;
    assert.ok(entry.name.length > 0);
  }
  assert.ok(count > 0, 'zip64 fixture missing entries');
  assert.equal(stats.bytes, stats.rangeBytes);
  assert.ok(stats.ranges.length > 0);
  await closeArchive(reader);

  const fileReader = await openArchive(new URL('thirdparty/zip/zip64.zip', FIXTURE_ROOT), { format: 'zip' });
  let fileCount = 0;
  for await (const entry of fileReader.entries()) {
    fileCount += 1;
    assert.ok(entry.name.length > 0);
  }
  assert.ok(fileCount > 0, 'zip64 file-path fixture missing entries');
  await closeArchive(fileReader);
});

test('zip seekable preflight rejects multi-disk archives', async (t) => {
  const bytes = new Uint8Array(await readFile(new URL('zip-preflight/multi-disk.zip', FIXTURE_ROOT)));
  const { server, stats } = await startRangeServer(bytes, true);
  t.after(() => server.close());

  const errorSchema = await loadSchema();
  await assert.rejects(
    () => openArchive(serverUrl(server, 'multi-disk.zip'), { format: 'zip' }),
    (err: unknown) => {
      if (!(err instanceof ZipError)) return false;
      assert.equal(err.code, 'ZIP_UNSUPPORTED_FEATURE');
      const json = err.toJSON();
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      return true;
    }
  );
  assert.equal(stats.bytes, stats.rangeBytes);

  await assert.rejects(
    () => openArchive(new URL('zip-preflight/multi-disk.zip', FIXTURE_ROOT), { format: 'zip' }),
    (err: unknown) => {
      if (!(err instanceof ZipError)) return false;
      assert.equal(err.code, 'ZIP_UNSUPPORTED_FEATURE');
      const json = err.toJSON();
      const result = validateSchema(errorSchema, json);
      assert.ok(result.ok, result.errors.join('\n'));
      return true;
    }
  );
});

async function closeArchive(reader: unknown): Promise<void> {
  const close = (reader as { close?: () => Promise<void> }).close;
  if (close) await close.call(reader);
}
