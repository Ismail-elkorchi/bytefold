import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ArchiveError, openArchive } from '@ismail-elkorchi/bytefold';
import { CompressionError, createDecompressor } from '@ismail-elkorchi/bytefold/compress';

const decoder = new TextDecoder();

test('openArchive reads tar.bz2 fixture and extracts entries', async () => {
  const data = await readFixture('fixture.tar.bz2');
  const reader = await openArchive(data);
  assert.equal(reader.format, 'tar.bz2');
  assert.ok(reader.detection);
  assert.equal(reader.detection?.detected.container, 'tar');
  assert.equal(reader.detection?.detected.compression, 'bzip2');
  assert.deepEqual(reader.detection?.detected.layers, ['bzip2', 'tar']);

  const entries: Record<string, Uint8Array> = {};
  for await (const entry of reader.entries()) {
    entries[entry.name] = await collect(await entry.open());
  }
  assert.deepEqual(Object.keys(entries).sort(), ['bin.dat', 'hello.txt']);
  assert.equal(decoder.decode(entries['hello.txt']!), 'hello tar.bz2\n');
  assert.equal(entries['bin.dat']!.length, 256);
  for (let i = 0; i < 256; i += 1) {
    assert.equal(entries['bin.dat']![i], i);
  }
});

test('tar.bz2 audit passes for fixture', async () => {
  const data = await readFixture('fixture.tar.bz2');
  const reader = await openArchive(data);
  const report = await reader.audit({ profile: 'agent' });
  assert.equal(report.ok, true);
  assert.equal(report.summary.errors, 0);
});

test('bz2 single-file name inference honors filename', async () => {
  const data = await readFixture('hello.txt.bz2');
  const reader = await openArchive(data, { filename: 'hello.txt.bz2' });
  assert.equal(reader.format, 'bz2');
  const entries: string[] = [];
  for await (const entry of reader.entries()) {
    entries.push(entry.name);
    const text = decoder.decode(await collect(await entry.open()));
    assert.equal(text, 'hello bzip2\n');
  }
  assert.deepEqual(entries, ['hello.txt']);
});

test('bz2 single-file name defaults to data without filename hint', async () => {
  const data = await readFixture('hello.txt.bz2');
  const reader = await openArchive(data);
  assert.equal(reader.format, 'bz2');
  const entries: string[] = [];
  for await (const entry of reader.entries()) {
    entries.push(entry.name);
  }
  assert.deepEqual(entries, ['data']);
});

test('bzip2 corruption throws typed error', async () => {
  const original = await readFixture('hello.txt.bz2');
  const corrupted = new Uint8Array(original);
  const flipIndex = corrupted.length > 6 ? corrupted.length - 6 : 0;
  corrupted[flipIndex] = (corrupted[flipIndex] ?? 0) ^ 0xff;

  const decompressor = createDecompressor({ algorithm: 'bzip2' });
  await assert.rejects(
    async () => {
      await collect(chunkStream(corrupted).pipeThrough(decompressor));
    },
    (err: unknown) =>
      err instanceof CompressionError &&
      (err.code === 'COMPRESSION_BZIP2_BAD_DATA' || err.code === 'COMPRESSION_BZIP2_CRC_MISMATCH')
  );
});

test('bzip2 aborts when signal is triggered mid-stream', async () => {
  const data = await readFixture('fixture.tar.bz2');
  const controller = new AbortController();
  let aborted = false;
  const decompressor = createDecompressor({
    algorithm: 'bzip2',
    signal: controller.signal,
    onProgress: (ev) => {
      if (!aborted && ev.bytesIn >= 64n) {
        aborted = true;
        controller.abort();
      }
    }
  });

  await assert.rejects(
    async () => {
      await collect(chunkStream(data, 32).pipeThrough(decompressor));
    },
    (err: unknown) => {
      if (!err || typeof err !== 'object') return false;
      return (err as { name?: string }).name === 'AbortError';
    }
  );
});

test('xz payloads are detected and rejected', async () => {
  const data = await readFixture('hello.txt.xz');
  await assert.rejects(
    async () => {
      await openArchive(data);
    },
    (err: unknown) => err instanceof ArchiveError && err.code === 'ARCHIVE_UNSUPPORTED_FORMAT'
  );
});

async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`../test/fixtures/${name}`, import.meta.url)));
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
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
