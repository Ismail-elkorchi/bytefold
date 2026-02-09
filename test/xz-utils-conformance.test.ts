import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CompressionError, createDecompressor, type CompressionOptions } from '@ismail-elkorchi/bytefold/compress';
import { extractAll } from '@ismail-elkorchi/bytefold/node';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FIXTURE_ROOT = new URL('../test/fixtures/xz-utils/', import.meta.url);
const GOOD_1_X86_PREPARED_SHA256 = 'dee7bc599bfc07147a302f44d1e994140bc812029baa4394d703e73e29117113';
const GOOD_1_X86_PREPARED_BYTES = 1388;

const GOOD_FIXTURES = [
  'good-0-empty.xz',
  'good-0pad-empty.xz',
  'good-0cat-empty.xz',
  'good-0catpad-empty.xz',
  'good-1-check-none.xz',
  'good-1-check-crc32.xz',
  'good-1-check-crc64.xz',
  'good-1-check-sha256.xz',
  'good-1-delta-lzma2.tiff.xz',
  'good-1-x86-lzma2.xz',
  'good-2-lzma2.xz'
];

const BAD_FIXTURES = [
  'bad-0-header_magic.xz',
  'bad-0-footer_magic.xz',
  'bad-1-check-crc32.xz',
  'bad-1-check-crc64.xz',
  'bad-1-check-sha256.xz'
];

const UNSUPPORTED_FIXTURES = [
  'unsupported-check.xz',
  'unsupported-filter_flags-1.xz',
  'unsupported-filter_flags-2.xz',
  'unsupported-filter_flags-3.xz'
];

test('xz utils fixtures: good streams decode', async () => {
  for (const name of GOOD_FIXTURES) {
    const data = await readFixture(name);
    const output = await decompressBytes(data, 64);
    assert.ok(output instanceof Uint8Array, name);
  }
});

test('xz utils fixtures: bad streams throw typed errors', async () => {
  for (const name of BAD_FIXTURES) {
    const data = await readFixture(name);
    await assert.rejects(
      async () => {
        await decompressBytes(data, 64);
      },
      (err: unknown) =>
        err instanceof CompressionError &&
        (err.code === 'COMPRESSION_XZ_BAD_DATA' ||
          err.code === 'COMPRESSION_XZ_BAD_CHECK' ||
          err.code === 'COMPRESSION_XZ_TRUNCATED' ||
          err.code === 'COMPRESSION_LZMA_BAD_DATA')
    );
  }
});

test('xz utils fixtures: unsupported streams throw typed unsupported errors', async () => {
  for (const name of UNSUPPORTED_FIXTURES) {
    const data = await readFixture(name);
    await assert.rejects(
      async () => {
        await decompressBytes(data, 64);
      },
      (err: unknown) => {
        if (!(err instanceof CompressionError)) return false;
        return err.code === 'COMPRESSION_XZ_UNSUPPORTED_CHECK' || err.code === 'COMPRESSION_XZ_UNSUPPORTED_FILTER';
      }
    );
  }
});

test('xz utils fixture x86 output matches pinned prepared bcj digest', async () => {
  const data = await readFixture('good-1-x86-lzma2.xz');
  const output = await decompressBytes(data, 64);
  assert.equal(output.length, GOOD_1_X86_PREPARED_BYTES);
  assert.equal(sha256Hex(output), GOOD_1_X86_PREPARED_SHA256);
});

test('xz utils delta tiff output has valid header and pinned size', async () => {
  const data = await readFixture('good-1-delta-lzma2.tiff.xz');
  const output = await decompressBytes(data, 64);
  const isLittle = output[0] === 0x49 && output[1] === 0x49 && output[2] === 0x2a && output[3] === 0x00;
  const isBig = output[0] === 0x4d && output[1] === 0x4d && output[2] === 0x00 && output[3] === 0x2a;
  assert.ok(isLittle || isBig);
  assert.equal(output.length, 929138);
});

test('xz streaming outputs before full input and stays bounded', async () => {
  const data = await readFixture('good-2-lzma2.xz');
  const debug = { maxBufferedInputBytes: 0, maxDictionaryBytesUsed: 0, totalBytesIn: 0, totalBytesOut: 0 };
  const options = { algorithm: 'xz', __xzDebug: debug } as CompressionOptions & {
    __xzDebug: {
      maxBufferedInputBytes?: number;
      maxDictionaryBytesUsed?: number;
      totalBytesIn?: number;
      totalBytesOut?: number;
    };
  };
  const decompressor = createDecompressor(options);
  const writer = decompressor.writable.getWriter();
  const reader = decompressor.readable.getReader();

  let sawEarlyOutput = false;
  let writingDone = false;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const readTask = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.length;
      if (!writingDone) sawEarlyOutput = true;
    }
  })();

  let offset = 0;
  while (offset < data.length) {
    const chunkSize = Math.min(1 + (offset % 32), data.length - offset);
    await writer.write(data.subarray(offset, offset + chunkSize));
    offset += chunkSize;
  }
  writingDone = true;
  await writer.close();
  await readTask;

  const output = concatBytes(chunks, total);
  assert.ok(output.length > 0);
  assert.ok(sawEarlyOutput);
  assert.ok(debug.maxBufferedInputBytes !== undefined && debug.maxBufferedInputBytes < 128 * 1024);
  assert.equal(debug.totalBytesIn, data.length);
  assert.equal(debug.totalBytesOut, output.length);
  assert.ok(debug.maxDictionaryBytesUsed !== undefined && debug.maxDictionaryBytesUsed > 0);
});

test('xz buffered input limit triggers typed error', async () => {
  const data = await readFixture('good-2-lzma2.xz');
  const decompressor = createDecompressor({ algorithm: 'xz', maxBufferedInputBytes: 4 });
  await assert.rejects(
    async () => {
      await collect(chunkStream(data, 4).pipeThrough(decompressor));
    },
    (err: unknown) => err instanceof CompressionError && err.code === 'COMPRESSION_XZ_BUFFER_LIMIT'
  );
});

test('xz dictionary limit rejects oversize dictionaries', async () => {
  const data = await readFixture('good-2-lzma2.xz');
  const decompressor = createDecompressor({ algorithm: 'xz', maxDictionaryBytes: 1024 });
  await assert.rejects(
    async () => {
      await collect(chunkStream(data, 32).pipeThrough(decompressor));
    },
    (err: unknown) => err instanceof CompressionError && err.code === 'COMPRESSION_RESOURCE_LIMIT'
  );
});

test('xz concatenated streams decode sequentially', async () => {
  const data = await readFixture('good-1-check-crc64.xz');
  const single = await decompressBytes(data, 64);
  const concatenated = concatBytes([data, data]);
  const output = await decompressBytes(concatenated, 64);
  assert.equal(output.length, single.length * 2);
  assert.deepEqual(output, concatBytes([single, single]));
});

test('xz stream padding is accepted', async () => {
  const data = await readFixture('good-1-check-crc64.xz');
  const padded = concatBytes([data, new Uint8Array(4)]);
  const output = await decompressBytes(padded, 64);
  const expected = await decompressBytes(data, 64);
  assert.deepEqual(output, expected);
});

test('xz extractAll is atomic for corrupted streams', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bytefold-xz-'));
  const bad = await readFixture('bad-1-check-crc32.xz');
  await assert.rejects(
    async () => {
      await extractAll(bad, dir, { filename: 'bad-1-check-crc32.xz' });
    },
    (err: unknown) => err instanceof CompressionError
  );
  const target = path.join(dir, 'bad-1-check-crc32');
  await assert.rejects(async () => {
    await stat(target);
  });
  await rm(dir, { recursive: true, force: true });
});

async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(name, FIXTURE_ROOT)));
}

async function decompressBytes(data: Uint8Array, chunkSize = 64): Promise<Uint8Array> {
  const decompressor = createDecompressor({ algorithm: 'xz' });
  return collect(chunkStream(data, chunkSize).pipeThrough(decompressor));
}

function chunkStream(data: Uint8Array, chunkSize = 64): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, data.length);
      controller.enqueue(data.subarray(offset, end));
      offset = end;
    }
  });
}

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
  return concatBytes(chunks, total);
}

function concatBytes(chunks: Uint8Array[], total?: number): Uint8Array {
  const size = total ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
