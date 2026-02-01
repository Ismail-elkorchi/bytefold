import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openArchive } from '@ismail-elkorchi/bytefold';
import { CompressionError, createDecompressor, type CompressionProgressEvent } from '@ismail-elkorchi/bytefold/compress';

const decoder = new TextDecoder();

test('openArchive reads xz fixture and extracts entry', async () => {
  const data = await readFixture('hello.txt.xz');
  const reader = await openArchive(data);
  assert.equal(reader.format, 'xz');
  const entries: string[] = [];
  for await (const entry of reader.entries()) {
    entries.push(entry.name);
    const text = decoder.decode(await collect(await entry.open()));
    assert.equal(text, 'hello from bytefold\n');
  }
  assert.deepEqual(entries, ['data']);
});

test('xz single-file name honors filename hint', async () => {
  const data = await readFixture('hello.txt.xz');
  const reader = await openArchive(data, { filename: 'hello.txt.xz' });
  const entries: string[] = [];
  for await (const entry of reader.entries()) {
    entries.push(entry.name);
  }
  assert.deepEqual(entries, ['hello.txt']);
});

test('xz CRC64 and CRC32 variants decode', async () => {
  const crc64 = await readFixture('hello.txt.xz');
  const crc32 = await readFixture('hello.txt.crc32.xz');

  const decompressor = createDecompressor({ algorithm: 'xz' });
  const output64 = decoder.decode(await collect(chunkStream(crc64).pipeThrough(decompressor)));
  assert.equal(output64, 'hello from bytefold\n');

  const decompressor32 = createDecompressor({ algorithm: 'xz' });
  const output32 = decoder.decode(await collect(chunkStream(crc32).pipeThrough(decompressor32)));
  assert.equal(output32, 'hello from bytefold\n');
});

test('xz corruption throws typed error', async () => {
  const original = await readFixture('hello.txt.xz');
  const corrupted = new Uint8Array(original);
  const flipIndex = corrupted.length > 6 ? corrupted.length - 6 : 0;
  corrupted[flipIndex] = (corrupted[flipIndex] ?? 0) ^ 0xff;

  const decompressor = createDecompressor({ algorithm: 'xz' });
  await assert.rejects(
    async () => {
      await collect(chunkStream(corrupted).pipeThrough(decompressor));
    },
    (err: unknown) =>
      err instanceof CompressionError &&
      (err.code === 'COMPRESSION_XZ_CHECK_MISMATCH' ||
        err.code === 'COMPRESSION_XZ_BAD_DATA' ||
        err.code === 'COMPRESSION_LZMA_BAD_DATA')
  );
});

test('xz aborts when signal is triggered mid-stream', async () => {
  const data = await readFixture('hello.txt.xz');
  const controller = new AbortController();
  let aborted = false;
  const decompressor = createDecompressor({
    algorithm: 'xz',
    signal: controller.signal,
    onProgress: (ev) => {
      if (!aborted && ev.bytesIn >= 8n) {
        aborted = true;
        controller.abort();
      }
    }
  });

  await assert.rejects(
    async () => {
      await collect(chunkStream(data, 8).pipeThrough(decompressor));
    },
    (err: unknown) => {
      if (!err || typeof err !== 'object') return false;
      return (err as { name?: string }).name === 'AbortError';
    }
  );
});

test('xz progress events are monotonic', async () => {
  const data = await readFixture('hello.txt.xz');
  const events: CompressionProgressEvent[] = [];
  const decompressor = createDecompressor({
    algorithm: 'xz',
    onProgress: (ev) => events.push(ev)
  });
  const output = decoder.decode(await collect(chunkStream(data, 8).pipeThrough(decompressor)));
  assert.equal(output, 'hello from bytefold\n');
  assertMonotonic(events);
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

function assertMonotonic(events: CompressionProgressEvent[]): void {
  let lastIn = 0n;
  let lastOut = 0n;
  for (const ev of events) {
    assert.ok(ev.bytesIn >= lastIn);
    assert.ok(ev.bytesOut >= lastOut);
    lastIn = ev.bytesIn;
    lastOut = ev.bytesOut;
  }
}
