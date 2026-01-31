import test from 'node:test';
import assert from 'node:assert/strict';
import { ZipReader, ZipWriter, ZipError } from '@ismail-elkorchi/bytefold/node/zip';

async function writeManyEntries(count: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const writer = ZipWriter.toWritable(writable);
  const payload = new Uint8Array([0]);
  for (let i = 0; i < count; i += 1) {
    await writer.add(`file-${i}.txt`, payload, { method: 0 });
  }
  await writer.close();
  return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

test('iterEntries streams without storing entries when disabled', async () => {
  const zip = await writeManyEntries(50000);
  const reader = await ZipReader.fromUint8Array(zip, {
    storeEntries: false,
    limits: { maxEntries: 100000 }
  });

  let count = 0;
  for await (const _entry of reader.iterEntries()) {
    count += 1;
  }
  assert.equal(count, 50000);
  assert.throws(() => reader.entries(), (err: unknown) => {
    return err instanceof ZipError && err.code === 'ZIP_ENTRIES_NOT_STORED';
  });
  await reader.close();
});
