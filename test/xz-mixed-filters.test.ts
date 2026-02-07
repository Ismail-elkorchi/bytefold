import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openArchive } from '@ismail-elkorchi/bytefold';

const FIXTURE_ROOT = new URL('../test/fixtures/', import.meta.url);

test('xz mixed filters (delta → x86 → lzma2) decode to expected bytes', async () => {
  const bytes = new Uint8Array(await readFile(new URL('xz-mixed/delta-x86-lzma2.xz', FIXTURE_ROOT)));
  const expected = new Uint8Array(await readFile(new URL('xz-mixed/delta-x86-lzma2.bin', FIXTURE_ROOT)));
  const reader = await openArchive(bytes);
  let payload: Uint8Array | null = null;
  for await (const entry of reader.entries()) {
    payload = await collect(await entry.open());
  }
  assert.ok(payload, 'missing payload');
  assert.deepEqual(payload, expected);
});

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
