import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openArchive } from '@ismail-elkorchi/bytefold/node';
import { ZipWriter } from '@ismail-elkorchi/bytefold/node/zip';
import { ZipError } from '@ismail-elkorchi/bytefold/zip';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const ERROR_SCHEMA = new URL('../schemas/error.schema.json', import.meta.url);

const BIG_SIZE = 4 * 1024 * 1024;
const BUDGET_DIVISOR = 16;
const RANGE_BLOCK_SIZE = 64 * 1024;

const SMALL_NAME = 'small.txt';
const BIG_NAME = 'big.bin';
const SMALL_CONTENT = new TextEncoder().encode('bytefold-zip-url-small');

const CENTRAL_DIR_LIMIT = 1024;
const ETAG_V1 = '"bytefold-etag-v1"';
const ETAG_V2 = '"bytefold-etag-v2"';
const WEAK_ETAG_V1 = 'W/"bytefold-etag-v1"';
const WEAK_ETAG_V2 = 'W/"bytefold-etag-v2"';
const LAST_MODIFIED = new Date(0).toUTCString();

type RangeStats = {
  bytes: number;
  rangeBytes: number;
  requests: number;
  headRequests: number;
  ranges: string[];
  statuses: number[];
  getRequests: number;
  missingRangeGets: number;
  ifRanges: (string | undefined)[];
  acceptEncodings: (string | undefined)[];
};

test('zip over HTTP range: list stays bounded and uses range reads only', async () => {
  const { bytes, size, cleanup } = await buildLargeZipFixture();
  const { server, stats, url } = await startRangeServer(bytes, {
    mode: 'range',
    etag: ETAG_V1,
    lastModified: LAST_MODIFIED
  });

  try {
    const reader = await openArchive(url, { format: 'zip', zip: { http: { cache: { maxBlocks: 0 } } } });
    const names: string[] = [];
    for await (const entry of reader.entries()) {
      names.push(entry.name);
    }
    assert.ok(names.includes(BIG_NAME));
    assert.ok(names.includes(SMALL_NAME));
    await closeArchive(reader);
  } finally {
    server.close();
    await cleanup();
  }

  const budgetBytes = budgetFor(size);
  assert.ok(stats.bytes < size);
  assert.ok(stats.bytes <= budgetBytes, `range bytes ${stats.bytes} exceeded budget ${budgetBytes}`);
  assert.ok(stats.requests <= requestBudgetFor(size), `requests ${stats.requests} exceeded budget`);
  assert.equal(stats.missingRangeGets, 0);
  assert.equal(stats.getRequests, stats.ranges.length);
  assertIfRangeMatches(stats.ifRanges, ETAG_V1);
  assertIdentityEncodings(stats.acceptEncodings);
});

test('zip over HTTP range: extracting small entry stays bounded', async () => {
  const { bytes, size, cleanup } = await buildLargeZipFixture();
  const { server, stats, url } = await startRangeServer(bytes, {
    mode: 'range',
    etag: ETAG_V1,
    lastModified: LAST_MODIFIED
  });

  try {
    const reader = await openArchive(url, { format: 'zip' });
    let found = false;
    for await (const entry of reader.entries()) {
      if (entry.name !== SMALL_NAME) continue;
      const payload = await collect(await entry.open());
      assert.deepEqual(payload, SMALL_CONTENT);
      found = true;
    }
    assert.ok(found, 'missing small.txt entry');
    await closeArchive(reader);
  } finally {
    server.close();
    await cleanup();
  }

  const budgetBytes = budgetFor(size);
  assert.ok(stats.bytes < size);
  assert.ok(stats.bytes <= budgetBytes, `range bytes ${stats.bytes} exceeded budget ${budgetBytes}`);
  assert.ok(stats.requests <= requestBudgetFor(size), `requests ${stats.requests} exceeded budget`);
  assert.equal(stats.missingRangeGets, 0);
  assert.equal(stats.getRequests, stats.ranges.length);
  assertIfRangeMatches(stats.ifRanges, ETAG_V1);
});

test('zip over HTTP range: range unsupported rejects with typed error', async () => {
  const { bytes, size, cleanup } = await buildLargeZipFixture();
  const { server, stats, url } = await startRangeServer(bytes, { mode: 'no-range' });
  const errorSchema = await loadSchema(ERROR_SCHEMA);

  try {
    await assert.rejects(
      () => openArchive(url, { format: 'zip' }),
      (err: unknown) => {
        if (!(err instanceof ZipError)) return false;
        assert.equal(err.code, 'ZIP_HTTP_RANGE_UNSUPPORTED');
        const result = validateSchema(errorSchema, err.toJSON());
        assert.ok(result.ok, result.errors.join('\n'));
        return true;
      }
    );
  } finally {
    server.close();
    await cleanup();
  }

  assert.ok(stats.bytes < size);
  assert.ok(stats.bytes <= budgetFor(size), `range unsupported bytes ${stats.bytes} exceeded budget`);
  assert.ok(stats.requests <= requestBudgetFor(size), `requests ${stats.requests} exceeded budget`);
  assert.equal(stats.missingRangeGets, 0);
});

test('zip over HTTP range: range unsupported aborts before body consumption (slow-body)', async () => {
  const { bytes, cleanup } = await buildLargeZipFixture();
  const { server, stats, url } = await startRangeServer(bytes, { mode: 'no-range-slow' });
  const errorSchema = await loadSchema(ERROR_SCHEMA);

  try {
    await assert.rejects(
      () => openArchive(url, { format: 'zip' }),
      (err: unknown) => {
        if (!(err instanceof ZipError)) return false;
        assert.equal(err.code, 'ZIP_HTTP_RANGE_UNSUPPORTED');
        const result = validateSchema(errorSchema, err.toJSON());
        assert.ok(result.ok, result.errors.join('\n'));
        return true;
      }
    );
  } finally {
    server.close();
    await cleanup();
  }

  assert.ok(stats.bytes <= 4096, `slow no-range served ${stats.bytes} bytes`);
  assert.equal(stats.missingRangeGets, 0);
});

test('zip over HTTP range: resource change rejects and yields no partial output', async () => {
  const { bytes, cleanup } = await buildLargeZipFixture();
  const { server, stats, url, setEtag } = await startRangeServer(bytes, {
    mode: 'range',
    etag: ETAG_V1,
    lastModified: LAST_MODIFIED
  });
  const errorSchema = await loadSchema(ERROR_SCHEMA);

  let error: unknown;
  let collectedLength = 0;

  try {
    const reader = await openArchive(url, { format: 'zip' });
    const names: string[] = [];
    for await (const entry of reader.entries()) {
      names.push(entry.name);
    }
    assert.ok(names.includes(SMALL_NAME));
    assert.ok(names.includes(BIG_NAME));
    setEtag(ETAG_V2);
    try {
      for await (const entry of reader.entries()) {
        if (entry.name !== BIG_NAME) continue;
        const stream = await entry.open();
        const streamReader = stream.getReader();
        try {
          const { value } = await streamReader.read();
          if (value) collectedLength = value.length;
        } finally {
          await streamReader.cancel().catch(() => {});
        }
      }
    } catch (err) {
      error = err;
    } finally {
      await closeArchive(reader);
    }
  } catch (err) {
    error = err;
  } finally {
    server.close();
    await cleanup();
  }

  assert.equal(collectedLength, 0);
  assert.ok(
    error instanceof ZipError,
    `expected ZipError, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
  );
  assert.equal((error as ZipError).code, 'ZIP_HTTP_RESOURCE_CHANGED');
  const result = validateSchema(errorSchema, (error as ZipError).toJSON());
  assert.ok(result.ok, result.errors.join('\n'));
  assert.ok(stats.bytes <= budgetFor(bytes.length), `resource change bytes ${stats.bytes} exceeded budget`);
  assert.ok(stats.requests <= requestBudgetFor(bytes.length), `requests ${stats.requests} exceeded budget`);
  assert.equal(stats.missingRangeGets, 0);
});

test('zip over HTTP range: If-Range mismatch with 200 yields resource changed', async () => {
  const { bytes, cleanup } = await buildLargeZipFixture();
  const { server, stats, url, setEtag } = await startRangeServer(bytes, {
    mode: 'if-range-200',
    etag: ETAG_V1,
    lastModified: LAST_MODIFIED
  });
  const errorSchema = await loadSchema(ERROR_SCHEMA);

  let error: unknown;
  try {
    const reader = await openArchive(url, { format: 'zip' });
    const names: string[] = [];
    for await (const entry of reader.entries()) {
      names.push(entry.name);
    }
    assert.ok(names.includes(SMALL_NAME));
    assert.ok(names.includes(BIG_NAME));
    setEtag(ETAG_V2);
    try {
      for await (const entry of reader.entries()) {
        if (entry.name !== BIG_NAME) continue;
        const stream = await entry.open();
        const streamReader = stream.getReader();
        try {
          await streamReader.read();
        } finally {
          await streamReader.cancel().catch(() => {});
        }
      }
    } catch (err) {
      error = err;
    } finally {
      await closeArchive(reader);
    }
  } catch (err) {
    error = err;
  } finally {
    server.close();
    await cleanup();
  }

  assert.ok(
    error instanceof ZipError,
    `expected ZipError, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
  );
  assert.equal((error as ZipError).code, 'ZIP_HTTP_RESOURCE_CHANGED');
  const result = validateSchema(errorSchema, (error as ZipError).toJSON());
  assert.ok(result.ok, result.errors.join('\n'));
  assert.ok(stats.bytes <= budgetFor(bytes.length), `if-range 200 bytes ${stats.bytes} exceeded budget`);
  assert.ok(stats.requests <= requestBudgetFor(bytes.length), `requests ${stats.requests} exceeded budget`);
  assert.equal(stats.missingRangeGets, 0);
  assertIfRangeMatches(stats.ifRanges, ETAG_V1);
  assertIdentityEncodings(stats.acceptEncodings);
});

test('zip over HTTP range: HEAD blocked falls back to range', async () => {
  const { bytes, size, cleanup } = await buildLargeZipFixture();
  const { server, stats, url } = await startRangeServer(bytes, {
    mode: 'head-blocked',
    etag: ETAG_V1,
    lastModified: LAST_MODIFIED
  });

  try {
    const reader = await openArchive(url, { format: 'zip' });
    const names: string[] = [];
    for await (const entry of reader.entries()) {
      names.push(entry.name);
    }
    assert.ok(names.includes(BIG_NAME));
    assert.ok(names.includes(SMALL_NAME));
    await closeArchive(reader);
  } finally {
    server.close();
    await cleanup();
  }

  const budgetBytes = budgetFor(size);
  assert.ok(stats.bytes < size);
  assert.ok(stats.bytes <= budgetBytes, `range bytes ${stats.bytes} exceeded budget ${budgetBytes}`);
  assert.ok(stats.requests <= requestBudgetFor(size), `requests ${stats.requests} exceeded budget`);
  assert.ok(stats.headRequests >= 1);
  assert.ok(stats.statuses.includes(405));
  assert.equal(stats.missingRangeGets, 0);
});

test('zip over HTTP range: content-encoding rejects with typed error', async () => {
  const { bytes, cleanup } = await buildLargeZipFixture();
  const { server, stats, url } = await startRangeServer(bytes, {
    mode: 'content-encoding',
    etag: ETAG_V1,
    lastModified: LAST_MODIFIED
  });
  const errorSchema = await loadSchema(ERROR_SCHEMA);

  try {
    await assert.rejects(
      () => openArchive(url, { format: 'zip' }),
      (err: unknown) => {
        if (!(err instanceof ZipError)) return false;
        assert.equal(err.code, 'ZIP_HTTP_CONTENT_ENCODING');
        const result = validateSchema(errorSchema, err.toJSON());
        assert.ok(result.ok, result.errors.join('\n'));
        return true;
      }
    );
  } finally {
    server.close();
    await cleanup();
  }

  assert.ok(stats.bytes <= budgetFor(bytes.length), `content-encoding bytes ${stats.bytes} exceeded budget`);
  assert.ok(stats.requests <= requestBudgetFor(bytes.length), `requests ${stats.requests} exceeded budget`);
  assert.equal(stats.missingRangeGets, 0);
  assertIdentityEncodings(stats.acceptEncodings);
  assertIfRangeMatches(stats.ifRanges, ETAG_V1);
});

test('zip over HTTP range: content-encoding aborts before body consumption (slow-body)', async () => {
  const { bytes, cleanup } = await buildLargeZipFixture();
  const { server, stats, url } = await startRangeServer(bytes, {
    mode: 'content-encoding-slow',
    etag: ETAG_V1,
    lastModified: LAST_MODIFIED
  });
  const errorSchema = await loadSchema(ERROR_SCHEMA);

  try {
    await assert.rejects(
      () => openArchive(url, { format: 'zip' }),
      (err: unknown) => {
        if (!(err instanceof ZipError)) return false;
        assert.equal(err.code, 'ZIP_HTTP_CONTENT_ENCODING');
        const result = validateSchema(errorSchema, err.toJSON());
        assert.ok(result.ok, result.errors.join('\n'));
        return true;
      }
    );
  } finally {
    server.close();
    await cleanup();
  }

  assert.ok(stats.bytes <= 4096, `slow content-encoding served ${stats.bytes} bytes`);
  assert.equal(stats.missingRangeGets, 0);
});

test('zip over HTTP range: weak ETag does not send If-Range and mismatch rejects', async () => {
  const { bytes, cleanup } = await buildLargeZipFixture();
  const { server, stats, url, setEtag } = await startRangeServer(bytes, {
    mode: 'range',
    etag: WEAK_ETAG_V1,
    lastModified: LAST_MODIFIED
  });
  const errorSchema = await loadSchema(ERROR_SCHEMA);

  let error: unknown;
  try {
    const reader = await openArchive(url, { format: 'zip' });
    for await (const entry of reader.entries()) {
      if (entry.name === SMALL_NAME) {
        const stream = await entry.open();
        const streamReader = stream.getReader();
        try {
          await streamReader.read();
        } finally {
          await streamReader.cancel().catch(() => {});
        }
        break;
      }
    }
    setEtag(WEAK_ETAG_V2);
    try {
      for await (const entry of reader.entries()) {
        if (entry.name !== BIG_NAME) continue;
        const stream = await entry.open();
        const streamReader = stream.getReader();
        try {
          await streamReader.read();
        } finally {
          await streamReader.cancel().catch(() => {});
        }
      }
    } catch (err) {
      error = err;
    } finally {
      await closeArchive(reader);
    }
  } catch (err) {
    error = err;
  } finally {
    server.close();
    await cleanup();
  }

  assert.ok(
    error instanceof ZipError,
    `expected ZipError, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
  );
  assert.equal((error as ZipError).code, 'ZIP_HTTP_RESOURCE_CHANGED');
  const result = validateSchema(errorSchema, (error as ZipError).toJSON());
  assert.ok(result.ok, result.errors.join('\n'));
  assert.ok(stats.ifRanges.every((value) => value === undefined), 'weak ETag should not send If-Range');
  assertIdentityEncodings(stats.acceptEncodings);
  assert.ok(stats.bytes <= budgetFor(bytes.length), `weak etag bytes ${stats.bytes} exceeded budget`);
  assert.ok(stats.requests <= requestBudgetFor(bytes.length), `requests ${stats.requests} exceeded budget`);
  assert.equal(stats.missingRangeGets, 0);
});

test('zip over HTTP range: require-strong-etag fails without strong validator', async () => {
  const { bytes, cleanup } = await buildLargeZipFixture();
  const { server, stats, url } = await startRangeServer(bytes, {
    mode: 'range',
    etag: WEAK_ETAG_V1,
    lastModified: LAST_MODIFIED
  });
  const errorSchema = await loadSchema(ERROR_SCHEMA);

  try {
    await assert.rejects(
      () =>
        openArchive(url, {
          format: 'zip',
          zip: { http: { snapshot: 'require-strong-etag' } }
        }),
      (err: unknown) => {
        if (!(err instanceof ZipError)) return false;
        assert.equal(err.code, 'ZIP_HTTP_STRONG_ETAG_REQUIRED');
        const result = validateSchema(errorSchema, err.toJSON());
        assert.ok(result.ok, result.errors.join('\n'));
        return true;
      }
    );
  } finally {
    server.close();
    await cleanup();
  }

  assert.ok(stats.bytes <= budgetFor(bytes.length), `strong-etag bytes ${stats.bytes} exceeded budget`);
  assert.ok(stats.requests <= requestBudgetFor(bytes.length), `requests ${stats.requests} exceeded budget`);
  assert.equal(stats.missingRangeGets, 0);
});
test('zip over HTTP range: malformed Content-Range rejects with typed error', async () => {
  const { bytes, cleanup } = await buildLargeZipFixture();
  const { server, stats, url } = await startRangeServer(bytes, {
    mode: 'bad-content-range',
    etag: ETAG_V1,
    lastModified: LAST_MODIFIED
  });
  const errorSchema = await loadSchema(ERROR_SCHEMA);

  try {
    await assert.rejects(
      () => openArchive(url, { format: 'zip' }),
      (err: unknown) => {
        if (!(err instanceof ZipError)) return false;
        assert.equal(err.code, 'ZIP_HTTP_RANGE_INVALID');
        const result = validateSchema(errorSchema, err.toJSON());
        assert.ok(result.ok, result.errors.join('\n'));
        return true;
      }
    );
  } finally {
    server.close();
    await cleanup();
  }

  assert.ok(stats.bytes <= budgetFor(bytes.length), `bad content-range bytes ${stats.bytes} exceeded budget`);
  assert.ok(stats.requests <= requestBudgetFor(bytes.length), `requests ${stats.requests} exceeded budget`);
  assert.equal(stats.missingRangeGets, 0);
});

test('zip over HTTP range: truncated 206 body fails list with ZIP_HTTP_BAD_RESPONSE', async () => {
  const { bytes, cleanup } = await buildLargeZipFixture();
  const { server, stats, url } = await startRangeServer(bytes, {
    mode: 'short-body',
    etag: ETAG_V1,
    lastModified: LAST_MODIFIED
  });
  const errorSchema = await loadSchema(ERROR_SCHEMA);

  try {
    await assert.rejects(
      async () => {
        const reader = await openArchive(url, { format: 'zip' });
        try {
          for await (const _entry of reader.entries()) {
            // iterate until failure
          }
        } finally {
          await closeArchive(reader);
        }
      },
      (err: unknown) => {
        if (!(err instanceof ZipError)) return false;
        assert.equal(err.code, 'ZIP_HTTP_BAD_RESPONSE');
        const result = validateSchema(errorSchema, err.toJSON());
        assert.ok(result.ok, result.errors.join('\n'));
        return true;
      }
    );
  } finally {
    server.close();
    await cleanup();
  }

  assert.equal(stats.missingRangeGets, 0);
});

test('zip over HTTP range: overrun 206 body fails extract with ZIP_HTTP_BAD_RESPONSE', async () => {
  const { bytes, cleanup } = await buildLargeZipFixture();
  const { server, stats, url, armLongBody } = await startRangeServer(bytes, {
    mode: 'long-body',
    etag: ETAG_V1,
    lastModified: LAST_MODIFIED
  });
  const errorSchema = await loadSchema(ERROR_SCHEMA);

  let error: unknown;
  try {
    const reader = await openArchive(url, {
      format: 'zip',
      zip: { http: { cache: { blockSize: 1024, maxBlocks: 0 } } }
    });
    try {
      for await (const _entry of reader.entries()) {
        // force list path first
      }
      armLongBody();
      for await (const entry of reader.entries()) {
        if (entry.name !== BIG_NAME) continue;
        const stream = await entry.open();
        const streamReader = stream.getReader();
        try {
          await streamReader.read();
        } finally {
          await streamReader.cancel().catch(() => {});
        }
      }
    } catch (err) {
      error = err;
    } finally {
      await closeArchive(reader);
    }
  } finally {
    server.close();
    await cleanup();
  }

  assert.ok(
    error instanceof ZipError,
    `expected ZipError, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
  );
  assert.equal((error as ZipError).code, 'ZIP_HTTP_BAD_RESPONSE');
  const result = validateSchema(errorSchema, (error as ZipError).toJSON());
  assert.ok(result.ok, result.errors.join('\n'));
  assert.equal(stats.missingRangeGets, 0);
});

test('zip preflight fails fast when central directory size exceeds limit (URL)', async () => {
  const bytes = buildCentralDirectoryLimitFixture();
  const { server, stats, url } = await startRangeServer(bytes, { mode: 'range', etag: ETAG_V1 });
  const errorSchema = await loadSchema(ERROR_SCHEMA);

  try {
    await assert.rejects(
      () => openArchive(url, { format: 'zip', limits: { maxZipCentralDirectoryBytes: CENTRAL_DIR_LIMIT } }),
      (err: unknown) => {
        if (!(err instanceof ZipError)) return false;
        assert.equal(err.code, 'ZIP_LIMIT_EXCEEDED');
        const result = validateSchema(errorSchema, err.toJSON());
        assert.ok(result.ok, result.errors.join('\n'));
        return true;
      }
    );
  } finally {
    server.close();
  }

  const expectedRanges = expectedTailRanges(bytes.length, 32 * 1024, Math.min(bytes.length, 0x10000 + 22));
  assert.deepEqual(stats.ranges, expectedRanges);
  assert.equal(stats.rangeBytes, sumRangeBytes(expectedRanges));
  assert.equal(stats.bytes, stats.rangeBytes);
});

type ZipFixture = { bytes: Uint8Array; size: number; cleanup: () => Promise<void> };
type RangeMode =
  | 'range'
  | 'no-range'
  | 'no-range-slow'
  | 'head-blocked'
  | 'bad-content-range'
  | 'if-range-200'
  | 'content-encoding'
  | 'content-encoding-slow'
  | 'short-body'
  | 'long-body';

async function buildLargeZipFixture(): Promise<ZipFixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bytefold-zip-url-'));
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = ZipWriter.toWritable(writable, { defaultMethod: 0 });
  const bigData = new Uint8Array(BIG_SIZE);
  for (let i = 0; i < bigData.length; i += 1) {
    bigData[i] = i & 0xff;
  }
  const timestamp = new Date(0);
  await writer.add(BIG_NAME, bigData, { method: 0, mtime: timestamp });
  await writer.add(SMALL_NAME, SMALL_CONTENT, { method: 0, mtime: timestamp });
  await writer.close();
  const bytes = concatChunks(chunks);
  const filePath = path.join(dir, 'fixture.zip');
  await writeFile(filePath, bytes);
  const fileBytes = new Uint8Array(await readFile(filePath));
  return { bytes: fileBytes, size: fileBytes.length, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function buildCentralDirectoryLimitFixture(): Uint8Array {
  const size = 70000;
  const bytes = new Uint8Array(size);
  const eocdOffset = size - 22;
  writeUint32LE(bytes, eocdOffset, 0x06054b50);
  writeUint16LE(bytes, eocdOffset + 4, 0);
  writeUint16LE(bytes, eocdOffset + 6, 0);
  writeUint16LE(bytes, eocdOffset + 8, 1);
  writeUint16LE(bytes, eocdOffset + 10, 1);
  writeUint32LE(bytes, eocdOffset + 12, CENTRAL_DIR_LIMIT + 1);
  writeUint32LE(bytes, eocdOffset + 16, 0);
  writeUint16LE(bytes, eocdOffset + 20, 0);
  return bytes;
}

function writeUint16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
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

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concatChunks(chunks);
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
  const ranges: string[] = [];
  for (let block = startBlock; block <= endBlock; block += blockSize) {
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

function budgetFor(size: number): number {
  return Math.ceil(size / BUDGET_DIVISOR);
}

function requestBudgetFor(size: number): number {
  return 1 + Math.ceil(budgetFor(size) / RANGE_BLOCK_SIZE) + 2;
}

async function loadSchema(url: URL): Promise<JsonSchema> {
  return (JSON.parse(await readFile(url, 'utf8')) as unknown) as JsonSchema;
}

function startRangeServer(
  data: Uint8Array,
  options: { mode: RangeMode; etag?: string; lastModified?: string }
): Promise<{
  server: http.Server;
  stats: RangeStats;
  url: string;
  setEtag: (etag: string) => void;
  setLastModified: (value: string) => void;
  armLongBody: () => void;
}> {
  let currentEtag = options.etag;
  let currentLastModified = options.lastModified;
  let longBodyActive = false;
  const stats: RangeStats = {
    bytes: 0,
    rangeBytes: 0,
    requests: 0,
    headRequests: 0,
    ranges: [],
    statuses: [],
    getRequests: 0,
    missingRangeGets: 0,
    ifRanges: [],
    acceptEncodings: []
  };

  const server = http.createServer((req, res) => {
    stats.requests += 1;
    const method = req.method ?? 'GET';
    const acceptEncoding = req.headers['accept-encoding'];
    stats.acceptEncodings.push(typeof acceptEncoding === 'string' ? acceptEncoding : undefined);
    const addValidators = () => {
      if (currentEtag) res.setHeader('ETag', currentEtag);
      if (currentLastModified) res.setHeader('Last-Modified', currentLastModified);
    };

    if (method === 'HEAD') {
      stats.headRequests += 1;
      if (options.mode === 'head-blocked') {
        res.statusCode = 405;
        stats.statuses.push(405);
        res.end();
        return;
      }
      res.statusCode = 200;
      stats.statuses.push(200);
      res.setHeader('Content-Length', data.length);
      addValidators();
      res.end();
      return;
    }

    if (method === 'GET') {
      stats.getRequests += 1;
      const ifRange = req.headers['if-range'];
      stats.ifRanges.push(typeof ifRange === 'string' ? ifRange : undefined);
    }

    const range = req.headers.range;
    if (typeof range !== 'string') {
      stats.missingRangeGets += 1;
    }

    if (options.mode === 'if-range-200') {
      const ifRangeHeader = req.headers['if-range'];
      if (typeof range === 'string' && typeof ifRangeHeader === 'string' && currentEtag && ifRangeHeader !== currentEtag) {
        res.statusCode = 200;
        stats.statuses.push(200);
        res.setHeader('Content-Length', data.length);
        addValidators();
        sendInChunks(res, data, stats, { trackRangeBytes: false });
        return;
      }
    }

    if (options.mode === 'no-range' || options.mode === 'no-range-slow') {
      res.statusCode = 200;
      stats.statuses.push(200);
      res.setHeader('Content-Length', data.length);
      addValidators();
      sendInChunks(res, data, stats, {
        trackRangeBytes: false,
        chunkSize: options.mode === 'no-range-slow' ? 512 : 16 * 1024,
        delay: options.mode === 'no-range-slow'
      });
      return;
    }

    if (typeof range !== 'string') {
      res.statusCode = 200;
      stats.statuses.push(200);
      res.setHeader('Content-Length', data.length);
      addValidators();
      sendInChunks(res, data, stats, { trackRangeBytes: false });
      return;
    }

    stats.ranges.push(range);
    const match = /^bytes=(\d+)-(\d+)?$/.exec(range);
    if (!match) {
      res.statusCode = 416;
      stats.statuses.push(416);
      res.end();
      return;
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : data.length - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= data.length) {
      res.statusCode = 416;
      stats.statuses.push(416);
      res.end();
      return;
    }
    const safeEnd = Math.min(end, data.length - 1);
    const body = data.subarray(start, safeEnd + 1);
    res.statusCode = 206;
    stats.statuses.push(206);
    res.setHeader('Accept-Ranges', 'bytes');
    if (options.mode === 'content-encoding' || options.mode === 'content-encoding-slow') {
      res.setHeader('Content-Encoding', 'gzip');
    }
    if (options.mode === 'bad-content-range') {
      res.setHeader('Content-Range', 'bytes 0-0/*');
    } else {
      res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${data.length}`);
    }
    addValidators();

    if (options.mode === 'short-body') {
      const truncated = body.subarray(0, Math.max(0, body.length - 1));
      res.setHeader('Content-Length', body.length);
      sendInChunks(res, truncated, stats, { trackRangeBytes: true });
      return;
    }

    if (options.mode === 'long-body' && longBodyActive) {
      const extended = new Uint8Array(body.length + 1);
      extended.set(body, 0);
      extended[extended.length - 1] = 0x42;
      sendInChunks(res, extended, stats, { trackRangeBytes: true, chunkSize: 256, delay: true });
      return;
    }

    if (options.mode === 'content-encoding-slow') {
      sendInChunks(res, body, stats, { trackRangeBytes: true, chunkSize: 512, delay: true });
      return;
    }

    res.setHeader('Content-Length', body.length);
    sendInChunks(res, body, stats, { trackRangeBytes: true });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      resolve({
        server,
        stats,
        url: `http://127.0.0.1:${address.port}/fixture.zip`,
        setEtag: (etag: string) => {
          currentEtag = etag;
        },
        setLastModified: (value: string) => {
          currentLastModified = value;
        },
        armLongBody: () => {
          longBodyActive = true;
        }
      });
    });
  });
}

function sendInChunks(
  res: http.ServerResponse,
  data: Uint8Array,
  stats: RangeStats,
  options: { trackRangeBytes: boolean; chunkSize?: number; delay?: boolean }
): void {
  const chunkSize = options.chunkSize ?? 16 * 1024;
  const delay = options.delay ?? false;
  let offset = 0;
  const send = () => {
    if (res.destroyed) return;
    if (offset >= data.length) {
      res.end();
      return;
    }
    const end = Math.min(offset + chunkSize, data.length);
    const chunk = data.subarray(offset, end);
    stats.bytes += chunk.length;
    if (options.trackRangeBytes) stats.rangeBytes += chunk.length;
    offset = end;
    if (!res.write(chunk)) {
      res.once('drain', send);
      return;
    }
    if (delay) {
      setTimeout(send, 1);
      return;
    }
    setImmediate(send);
  };
  send();
}

function assertIdentityEncodings(values: (string | undefined)[]): void {
  assert.ok(values.every(isIdentityEncoding), `unexpected Accept-Encoding values: ${values.join(', ')}`);
}

function assertIfRangeMatches(values: (string | undefined)[], expected: string): void {
  const present = values.filter((value): value is string => typeof value === 'string');
  assert.ok(present.length > 0, 'missing If-Range validator');
  assert.ok(
    present.every((value) => value === expected),
    `unexpected If-Range values: ${present.join(', ')}`
  );
}

function isIdentityEncoding(value: string | undefined): boolean {
  if (!value) return false;
  const tokens = value
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  return tokens.length === 1 && tokens[0] === 'identity';
}

async function closeArchive(reader: unknown): Promise<void> {
  const close = (reader as { close?: () => Promise<void> }).close;
  if (close) await close.call(reader);
}
