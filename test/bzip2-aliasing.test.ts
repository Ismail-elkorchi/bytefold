import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDecompressor } from '@ismail-elkorchi/bytefold/compress';

const FIXTURE = new URL('../test/fixtures/fixture.tar.bz2', import.meta.url);

test('bzip2 emitted chunks are immutable after enqueue', async () => {
  const data = new Uint8Array(await readFile(FIXTURE));
  const decompressor = createDecompressor({ algorithm: 'bzip2' });
  const reader = chunkStream(data, 64).pipeThrough(decompressor).getReader();

  let first: Uint8Array | null = null;
  let snapshot: Uint8Array | null = null;
  let chunks = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks += 1;
    if (!first) {
      first = value;
      snapshot = value.slice();
    }
  }

  assert.ok(first && snapshot);
  assert.ok(chunks > 1, `expected multiple chunks, got ${chunks}`);
  assert.deepEqual(first, snapshot);
});

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
