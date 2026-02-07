import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openArchive } from '@ismail-elkorchi/bytefold';
import { createDecompressor } from '@ismail-elkorchi/bytefold/compress';

const FIXTURE_ROOT = new URL('../test/fixtures/', import.meta.url);

test('xz concatenated streams honor BCJ start offsets per stream', async () => {
  const bytes = new Uint8Array(
    await readFile(new URL('xz-concat/concat-two-streams-bcj.xz', FIXTURE_ROOT))
  );
  const expected = new Uint8Array(
    await readFile(new URL('xz-concat/concat-two-streams-bcj.bin', FIXTURE_ROOT))
  );
  const reader = await openArchive(bytes);
  let payload: Uint8Array | null = null;
  for await (const entry of reader.entries()) {
    payload = await collect(await entry.open());
  }
  assert.ok(payload, 'missing payload');
  assert.deepEqual(payload, expected);
});

test('xz concatenated BCJ fixture survives tiny chunking', async () => {
  const bytes = new Uint8Array(
    await readFile(new URL('xz-concat/concat-two-streams-bcj.xz', FIXTURE_ROOT))
  );
  const expected = new Uint8Array(
    await readFile(new URL('xz-concat/concat-two-streams-bcj.bin', FIXTURE_ROOT))
  );
  const sizes = new Array(bytes.length).fill(1);
  const output = await decompressWithChunks(bytes, sizes);
  assert.deepEqual(output, expected);
});

async function decompressWithChunks(input: Uint8Array, sizes: number[]): Promise<Uint8Array> {
  let offset = 0;
  let index = 0;
  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= input.length) {
        controller.close();
        return;
      }
      const size = sizes[index] ?? (input.length - offset);
      index += 1;
      const end = Math.min(input.length, offset + size);
      controller.enqueue(input.subarray(offset, end));
      offset = end;
    }
  });
  const transform = createDecompressor({ algorithm: 'xz' });
  return collect(readable.pipeThrough(transform));
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
