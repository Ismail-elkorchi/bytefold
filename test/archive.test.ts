import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ArchiveError, openArchive, TarReader, TarWriter, createArchiveWriter } from '@ismail-elkorchi/bytefold';
import { getCompressionCapabilities } from '@ismail-elkorchi/bytefold/compress';

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
  assert.ok(reader.detection);
  assert.equal(reader.detection?.detected.container, 'tar');
  assert.equal(reader.detection?.detected.compression, 'gzip');
  assert.doesNotThrow(() => JSON.stringify(reader.detection));
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

test('openArchive supports Blob ZIP input and reports blob inputKind', async () => {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('zip', writable);
  await writer.add('hello.txt', encoder.encode('blob zip'));
  await writer.close();
  const zipBytes = concatChunks(chunks);

  const reader = await openArchive(new Blob([blobPartFromBytes(zipBytes)], { type: 'application/zip' }));
  assert.equal(reader.format, 'zip');
  assert.equal(reader.detection?.inputKind, 'blob');
  const names: string[] = [];
  for await (const entry of reader.entries()) {
    names.push(entry.name);
    const data = await collect(await entry.open());
    if (entry.name === 'hello.txt') {
      assert.equal(new TextDecoder().decode(data), 'blob zip');
    }
  }
  assert.deepEqual(names, ['hello.txt']);
});

test('openArchive supports Blob non-zip input', async () => {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('gz', writable);
  await writer.add('hello.txt', encoder.encode('blob gz'));
  await writer.close();
  const gzBytes = concatChunks(chunks);

  const reader = await openArchive(new Blob([blobPartFromBytes(gzBytes)], { type: 'application/gzip' }), {
    filename: 'hello.txt.gz'
  });
  assert.equal(reader.format, 'gz');
  assert.equal(reader.detection?.inputKind, 'blob');
  const entries: string[] = [];
  for await (const entry of reader.entries()) {
    entries.push(entry.name);
    const data = await collect(await entry.open());
    assert.equal(new TextDecoder().decode(data), 'blob gz');
  }
  assert.deepEqual(entries, ['hello.txt']);
});

test('openArchive detects tar.zst', async () => {
  const caps = getCompressionCapabilities();
  if (!caps.algorithms.zstd.compress || !caps.algorithms.zstd.decompress) {
    assert.fail('zstd support is required by the support matrix; update runtime policy or SPEC.md if unavailable');
  }
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('tar.zst', writable);
  await writer.add('hello.txt', encoder.encode('zstd tar'));
  await writer.close();
  const tzstBytes = concatChunks(chunks);

  const reader = await openArchive(tzstBytes);
  assert.equal(reader.format, 'tar.zst');
  assert.ok(reader.detection);
  assert.equal(reader.detection?.detected.container, 'tar');
  assert.equal(reader.detection?.detected.compression, 'zstd');
  assert.deepEqual(reader.detection?.detected.layers, ['zstd', 'tar']);
  const names: string[] = [];
  for await (const entry of reader.entries()) {
    names.push(entry.name);
    const data = await collect(await entry.open());
    assert.equal(new TextDecoder().decode(data), 'zstd tar');
  }
  assert.deepEqual(names, ['hello.txt']);
});

test('openArchive does not auto-detect tar.br without hint', async () => {
  const caps = getCompressionCapabilities();
  if (!caps.algorithms.brotli.compress || !caps.algorithms.brotli.decompress) {
    assert.fail('brotli support is required by the support matrix; update runtime policy or SPEC.md if unavailable');
  }
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('tar.br', writable);
  await writer.add('hello.txt', encoder.encode('brotli tar'));
  await writer.close();
  const tbrBytes = concatChunks(chunks);

  await assert.rejects(async () => {
    await openArchive(tbrBytes);
  }, (err: unknown) => err instanceof ArchiveError && err.code === 'ARCHIVE_UNSUPPORTED_FORMAT');
});

test('openArchive detects tar.br with explicit hint', async () => {
  const caps = getCompressionCapabilities();
  if (!caps.algorithms.brotli.compress || !caps.algorithms.brotli.decompress) {
    assert.fail('brotli support is required by the support matrix; update runtime policy or SPEC.md if unavailable');
  }
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('tar.br', writable);
  await writer.add('hello.txt', encoder.encode('brotli tar'));
  await writer.close();
  const tbrBytes = concatChunks(chunks);

  const reader = await openArchive(tbrBytes, { format: 'tar.br' });
  assert.equal(reader.format, 'tar.br');
  assert.ok(reader.detection);
  assert.equal(reader.detection?.detected.container, 'tar');
  assert.equal(reader.detection?.detected.compression, 'brotli');
  assert.deepEqual(reader.detection?.detected.layers, ['brotli', 'tar']);
  const names: string[] = [];
  for await (const entry of reader.entries()) {
    names.push(entry.name);
    const data = await collect(await entry.open());
    assert.equal(new TextDecoder().decode(data), 'brotli tar');
  }
  assert.deepEqual(names, ['hello.txt']);
});

test('openArchive reads tar.zst fixture', async () => {
  const caps = getCompressionCapabilities();
  if (!caps.algorithms.zstd.compress || !caps.algorithms.zstd.decompress) {
    assert.fail('zstd support is required by the support matrix; update runtime policy or SPEC.md if unavailable');
  }
  const bytes = new Uint8Array(await readFile(new URL('../test/fixtures/fixture.tar.zst', import.meta.url)));
  const reader = await openArchive(bytes);
  assert.equal(reader.format, 'tar.zst');
  const entries: string[] = [];
  for await (const entry of reader.entries()) {
    entries.push(entry.name);
    const data = await collect(await entry.open());
    assert.equal(new TextDecoder().decode(data), 'hello fixture\n');
  }
  assert.deepEqual(entries, ['hello.txt']);
});

test('openArchive reads tar.br fixture with explicit hint', async () => {
  const caps = getCompressionCapabilities();
  if (!caps.algorithms.brotli.compress || !caps.algorithms.brotli.decompress) {
    assert.fail('brotli support is required by the support matrix; update runtime policy or SPEC.md if unavailable');
  }
  const bytes = new Uint8Array(await readFile(new URL('../test/fixtures/fixture.tar.br', import.meta.url)));
  const reader = await openArchive(bytes, { format: 'tar.br' });
  assert.equal(reader.format, 'tar.br');
  const entries: string[] = [];
  for await (const entry of reader.entries()) {
    entries.push(entry.name);
    const data = await collect(await entry.open());
    assert.equal(new TextDecoder().decode(data), 'hello fixture\n');
  }
  assert.deepEqual(entries, ['hello.txt']);
});

test('agent workflow: open → audit → assertSafe → extract', async () => {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('zip', writable);
  await writer.add('safe.txt', encoder.encode('agent data'));
  await writer.close();
  const zipBytes = concatChunks(chunks);

  const reader = await openArchive(zipBytes, { profile: 'agent' });
  const report = await reader.audit({ profile: 'agent' });
  assert.equal(report.ok, true);
  await reader.assertSafe({ profile: 'agent' });
  const entries: string[] = [];
  for await (const entry of reader.entries()) {
    entries.push(entry.name);
    const data = await collect(await entry.open());
    assert.equal(new TextDecoder().decode(data), 'agent data');
  }
  assert.deepEqual(entries, ['safe.txt']);
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

function blobPartFromBytes(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  return owned.buffer;
}
