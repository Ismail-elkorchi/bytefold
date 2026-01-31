import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openArchive, TarReader, TarWriter, createArchiveWriter } from '@ismail-elkorchi/bytefold';

const encoder = new TextEncoder();

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

test('tar roundtrip with long name (pax)', async () => {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = TarWriter.toWritable(writable);
  const longName = `${'a'.repeat(120)}.txt`;
  await writer.add(longName, encoder.encode('hello tar'));
  await writer.close();

  const tarBytes = concatChunks(chunks);
  const reader = await TarReader.fromUint8Array(tarBytes);
  const entries = reader.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.name, longName);

  const stream = await reader.open(entries[0]!);
  const data = await collect(stream);
  assert.equal(new TextDecoder().decode(data), 'hello tar');
});

test('openArchive auto-detects tgz', async () => {
  const tarChunks: Uint8Array[] = [];
  const tarWritable = new WritableStream<Uint8Array>({
    write(chunk) {
      tarChunks.push(chunk);
    }
  });
  const tarWriter = TarWriter.toWritable(tarWritable);
  await tarWriter.add('file.txt', encoder.encode('tgz payload'));
  await tarWriter.close();
  const tarBytes = concatChunks(tarChunks);

  const gzipTransform = new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const gzStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(tarBytes);
      controller.close();
    }
  }).pipeThrough(gzipTransform);
  const gzBytes = await collect(gzStream);

  const reader = await openArchive(gzBytes);
  assert.equal(reader.format, 'tgz');
  const entries: { name: string }[] = [];
  for await (const entry of reader.entries()) {
    entries.push({ name: entry.name });
  }
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.name, 'file.txt');
});

test('createArchiveWriter (zip) roundtrip', async () => {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('zip', writable);
  await writer.add('hello.txt', encoder.encode('zip data'));
  await writer.close();
  const zipBytes = concatChunks(chunks);

  const reader = await openArchive(zipBytes);
  assert.equal(reader.format, 'zip');
});

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
