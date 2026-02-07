import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDecompressor } from '@ismail-elkorchi/bytefold/compress';

const FIXTURE = new URL('../test/fixtures/xz-utils/good-1-delta-lzma2.tiff.xz', import.meta.url);

test('xz emitted chunks are immutable after enqueue', async () => {
  const data = new Uint8Array(await readFile(FIXTURE));
  const decompressor = createDecompressor({ algorithm: 'xz' });
  const reader = new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  })
    .pipeThrough(decompressor)
    .getReader();

  const first = await reader.read();
  assert.ok(!first.done && first.value && first.value.length > 0);
  const snapshot = new Uint8Array(first.value);

  let chunks = 1;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.length > 0) chunks += 1;
  }

  assert.ok(chunks > 1, 'expected multiple output chunks');
  assert.deepEqual(first.value, snapshot);
});
