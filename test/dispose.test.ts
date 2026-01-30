import test from 'node:test';
import assert from 'node:assert/strict';
import { ZipReader, ZipWriter } from 'zip-next';

async function writeZip(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const writer = ZipWriter.toWritable(writable);
  await writer.add('hello.txt', new TextEncoder().encode('hello'));
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

test('async dispose closes reader and writer', async () => {
  const zip = await writeZip();
  const reader = await ZipReader.fromUint8Array(zip);
  await reader[Symbol.asyncDispose]();

  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const writer = ZipWriter.toWritable(writable);
  await writer.add('data.bin', new Uint8Array([1, 2, 3]));
  await writer[Symbol.asyncDispose]();
  assert.ok(chunks.length > 0);
});
