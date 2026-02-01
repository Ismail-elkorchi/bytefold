import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openArchive } from '@ismail-elkorchi/bytefold';

const decoder = new TextDecoder();

test('openArchive reads tar.xz fixture and extracts entries', async () => {
  const data = await readFixture('fixture.tar.xz');
  const reader = await openArchive(data);
  assert.equal(reader.format, 'tar.xz');
  assert.ok(reader.detection);
  assert.equal(reader.detection?.detected.container, 'tar');
  assert.equal(reader.detection?.detected.compression, 'xz');
  assert.deepEqual(reader.detection?.detected.layers, ['xz', 'tar']);

  const entries: Record<string, Uint8Array> = {};
  for await (const entry of reader.entries()) {
    entries[entry.name] = await collect(await entry.open());
  }
  assert.deepEqual(Object.keys(entries).sort(), ['bin.dat', 'hello.txt']);
  assert.equal(decoder.decode(entries['hello.txt']!), 'hello from bytefold\n');
  assert.deepEqual(Array.from(entries['bin.dat']!), [0, 1, 2, 3, 4, 5, 250, 251, 252, 253, 254, 255]);
});

async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`../test/fixtures/${name}`, import.meta.url)));
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
