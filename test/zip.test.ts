import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { ZipReader, ZipWriter, ZipError } from '@ismail-elkorchi/bytefold/node/zip';
import * as zlib from 'node:zlib';

async function writeZip(
  entries: Array<{ name: string; data: Uint8Array; method?: 0 | 8 | 93 }>,
  writerOptions?: { shouldForceZip64?: boolean }
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const writer = ZipWriter.toWritable(writable, writerOptions);
  for (const entry of entries) {
    const opts = entry.method !== undefined ? { method: entry.method } : undefined;
    await writer.add(entry.name, entry.data, opts);
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

async function readEntryBytes(reader: ZipReader, name: string): Promise<Uint8Array> {
  const entry = reader.entries().find((e) => e.name === name);
  assert.ok(entry, `missing entry ${name}`);
  const stream = await reader.open(entry);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

test('roundtrip store', async () => {
  const text = new TextEncoder().encode('hello');
  const bin = new Uint8Array([0, 1, 2, 3, 4, 5]);
  const zip = await writeZip([
    { name: 'hello.txt', data: text, method: 0 },
    { name: 'bin.dat', data: bin, method: 0 }
  ]);
  const reader = await ZipReader.fromUint8Array(zip);
  assert.equal(reader.entries().length, 2);
  assert.deepEqual(await readEntryBytes(reader, 'hello.txt'), text);
  assert.deepEqual(await readEntryBytes(reader, 'bin.dat'), bin);
});

test('roundtrip deflate', async () => {
  const text = new TextEncoder().encode('deflate data');
  const zip = await writeZip([{ name: 'deflate.txt', data: text, method: 8 }]);
  const reader = await ZipReader.fromUint8Array(zip);
  assert.deepEqual(await readEntryBytes(reader, 'deflate.txt'), text);
});

test('roundtrip zstd', async (t) => {
  if (typeof zlib.createZstdCompress !== 'function') {
    t.skip('zstd not available');
    return;
  }
  const text = new TextEncoder().encode('zstd data');
  const zip = await writeZip([{ name: 'zstd.txt', data: text, method: 93 }]);
  const reader = await ZipReader.fromUint8Array(zip);
  assert.deepEqual(await readEntryBytes(reader, 'zstd.txt'), text);
});

test('data descriptor signature handling', async () => {
  const data = new TextEncoder().encode('descriptor');
  const zip = await writeZip([{ name: 'file.txt', data, method: 0 }]);

  const signature = new Uint8Array([0x50, 0x4b, 0x07, 0x08]);
  const sigIndex = findSequence(zip, signature);
  assert.ok(sigIndex >= 0, 'data descriptor signature not found');

  const reader = await ZipReader.fromUint8Array(zip);
  const entry = reader.entries()[0]!;
  assert.ok((entry.flags & 0x08) !== 0, 'data descriptor flag not set');

  const modified = zip.slice();
  if (sigIndex >= 0) {
    modified[sigIndex] = 0;
    modified[sigIndex + 1] = 0;
    modified[sigIndex + 2] = 0;
    modified[sigIndex + 3] = 0;
  }

  const reader2 = await ZipReader.fromUint8Array(modified);
  assert.deepEqual(await readEntryBytes(reader2, 'file.txt'), data);
});

test('zip64 forced', async () => {
  const data = new TextEncoder().encode('zip64');
  const zip = await writeZip([{ name: 'zip64.txt', data, method: 0 }], { shouldForceZip64: true });

  assert.ok(findSequence(zip, new Uint8Array([0x50, 0x4b, 0x06, 0x06])) >= 0, 'zip64 EOCD missing');
  assert.ok(findSequence(zip, new Uint8Array([0x50, 0x4b, 0x06, 0x07])) >= 0, 'zip64 locator missing');

  const reader = await ZipReader.fromUint8Array(zip);
  const entry = reader.entries()[0]!;
  assert.equal(entry.zip64, true);
  assert.equal(typeof entry.offset, 'bigint');
  assert.equal(typeof entry.compressedSize, 'bigint');
  assert.equal(typeof entry.uncompressedSize, 'bigint');
});

test('utf-8 filenames', async () => {
  const name = 'café.txt';
  const data = new TextEncoder().encode('accent');
  const zip = await writeZip([{ name, data, method: 0 }]);
  const reader = await ZipReader.fromUint8Array(zip);
  assert.equal(reader.entries()[0]!.name, name);
});

test('extractAll path traversal protection', async () => {
  const data = new TextEncoder().encode('evil');
  const zip = await writeZip([{ name: '../evil.txt', data, method: 0 }]);
  const reader = await ZipReader.fromUint8Array(zip);
  const dir = await makeTempDir();
  await assert.rejects(async () => {
    await reader.extractAll(dir);
  }, (err: unknown) => {
    return err instanceof ZipError && err.code === 'ZIP_PATH_TRAVERSAL';
  });
});

test('crc mismatch in strict mode', async () => {
  const data = new TextEncoder().encode('crc');
  const zip = await writeZip([{ name: 'crc.txt', data, method: 0 }]);
  const reader = await ZipReader.fromUint8Array(zip);
  const entry = reader.entries()[0]!;

  const mutated = zip.slice();
  const dataOffset = findLocalDataOffset(zip, entry.offset);
  mutated[dataOffset] = (mutated[dataOffset] ?? 0) ^ 0xff;

  const reader2 = await ZipReader.fromUint8Array(mutated);
  const entry2 = reader2.entries()[0]!;
  await assert.rejects(async () => {
    const stream = await reader2.open(entry2);
    await new Response(stream).arrayBuffer();
  }, (err: unknown) => err instanceof ZipError && err.code === 'ZIP_BAD_CRC');
});

function findSequence(buffer: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= buffer.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (buffer[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function findLocalDataOffset(buffer: Uint8Array, offset: bigint): number {
  const start = Number(offset);
  const signature = readUint32LE(buffer, start);
  assert.equal(signature, 0x04034b50);
  const nameLen = readUint16LE(buffer, start + 26);
  const extraLen = readUint16LE(buffer, start + 28);
  return start + 30 + nameLen + extraLen;
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8);
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
  return (
    buffer[offset]! |
    (buffer[offset + 1]! << 8) |
    (buffer[offset + 2]! << 16) |
    (buffer[offset + 3]! << 24)
  ) >>> 0;
}

async function makeTempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `bytefold-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
