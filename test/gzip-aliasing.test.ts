import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompressor, createDecompressor } from '@ismail-elkorchi/bytefold/compress';

const encoder = new TextEncoder();

test('gzip emitted chunks are immutable after enqueue', async () => {
  const payload = encoder.encode('a'.repeat(512 * 1024));
  const gzBytes = await collect(chunkStream(payload, 4096).pipeThrough(createCompressor({ algorithm: 'gzip' })));

  const reader = chunkStream(gzBytes, 128).pipeThrough(createDecompressor({ algorithm: 'gzip' })).getReader();
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

function chunkStream(data: Uint8Array, chunkSize = 1024): ReadableStream<Uint8Array> {
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
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
