import test from 'node:test';
import assert from 'node:assert/strict';
import { ZipError, ZipReader, ZipWriter } from '@ismail-elkorchi/bytefold/node/zip';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CDFH_SIGNATURE = 0x02014b50;

test('zip64 writer structural proof: forced mode emits ZIP64 EOCD + locator + entry extras', async () => {
  const zip = await writeForcedZip64Archive();
  const eocdOffset = findSignatureFromEnd(zip, EOCD_SIGNATURE);
  assert.ok(eocdOffset >= 0, 'EOCD signature missing');

  assert.equal(readUint16LE(zip, eocdOffset + 8), 0xffff);
  assert.equal(readUint16LE(zip, eocdOffset + 10), 0xffff);
  assert.equal(readUint32LE(zip, eocdOffset + 12), 0xffffffff);
  assert.equal(readUint32LE(zip, eocdOffset + 16), 0xffffffff);

  const locatorOffset = findSignatureFromEnd(zip, ZIP64_LOCATOR_SIGNATURE);
  assert.equal(locatorOffset, eocdOffset - 20, 'ZIP64 locator must precede EOCD');
  const zip64EocdOffset = Number(readUint64LE(zip, locatorOffset + 8));
  assert.equal(readUint32LE(zip, zip64EocdOffset), ZIP64_EOCD_SIGNATURE);

  const entryCount = readUint64LE(zip, zip64EocdOffset + 24);
  const totalEntries = readUint64LE(zip, zip64EocdOffset + 32);
  const cdSize = readUint64LE(zip, zip64EocdOffset + 40);
  const cdOffset = readUint64LE(zip, zip64EocdOffset + 48);

  assert.equal(entryCount, 2n);
  assert.equal(totalEntries, 2n);
  assert.ok(cdSize > 0n);
  assert.ok(cdOffset > 0n && cdOffset < BigInt(locatorOffset));

  const parsedEntryCount = assertForcedZip64CentralDirectoryEntries(zip, Number(cdOffset), Number(totalEntries));
  assert.equal(parsedEntryCount, 2);
});

test('zip64 writer structural proof: forced ZIP64 archives are readable and payload-stable', async () => {
  const zip = await writeForcedZip64Archive();
  const reader = await ZipReader.fromUint8Array(zip);
  const entries = reader.entries().slice().sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['a.txt', 'nested/b.txt']
  );
  for (const entry of entries) {
    assert.equal(entry.zip64, true);
  }

  const extractedA = await readEntryText(reader, 'a.txt');
  const extractedB = await readEntryText(reader, 'nested/b.txt');
  assert.equal(extractedA, 'zip64-a');
  assert.equal(extractedB, 'zip64-b');
});

test('zip64 writer structural proof: malformed forced ZIP64 locator yields typed error', async () => {
  const zip = await writeForcedZip64Archive();
  const locatorOffset = findSignatureFromEnd(zip, ZIP64_LOCATOR_SIGNATURE);
  assert.ok(locatorOffset >= 0, 'ZIP64 locator missing');
  writeUint32LE(zip, locatorOffset, 0);

  await assert.rejects(
    () => ZipReader.fromUint8Array(zip),
    (error: unknown) => {
      assert.ok(!(error instanceof RangeError), 'expected typed ZipError, received RangeError');
      return error instanceof ZipError && error.code === 'ZIP_BAD_ZIP64';
    }
  );
});

async function writeForcedZip64Archive(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const writer = ZipWriter.toWritable(writable, { shouldForceZip64: true });
  await writer.add('a.txt', new TextEncoder().encode('zip64-a'), { method: 0 });
  await writer.add('nested/b.txt', new TextEncoder().encode('zip64-b'), { method: 0 });
  await writer.close();
  return concat(chunks);
}

function assertForcedZip64CentralDirectoryEntries(buffer: Uint8Array, offset: number, expectedEntries: number): number {
  let pointer = offset;
  let count = 0;
  while (count < expectedEntries) {
    assert.equal(readUint32LE(buffer, pointer), CDFH_SIGNATURE, `missing CDFH signature at ${pointer}`);
    assert.equal(readUint16LE(buffer, pointer + 6), 45, 'ZIP64 entries must require version 45');
    assert.equal(readUint32LE(buffer, pointer + 20), 0xffffffff, 'compressed size sentinel missing');
    assert.equal(readUint32LE(buffer, pointer + 24), 0xffffffff, 'uncompressed size sentinel missing');
    assert.equal(readUint32LE(buffer, pointer + 42), 0xffffffff, 'offset sentinel missing');

    const nameLength = readUint16LE(buffer, pointer + 28);
    const extraLength = readUint16LE(buffer, pointer + 30);
    const commentLength = readUint16LE(buffer, pointer + 32);
    const extraOffset = pointer + 46 + nameLength;
    const extra = buffer.subarray(extraOffset, extraOffset + extraLength);
    assert.ok(hasExtraField(extra, 0x0001), 'ZIP64 extra field missing');

    pointer += 46 + nameLength + extraLength + commentLength;
    count += 1;
  }
  return count;
}

function hasExtraField(extra: Uint8Array, id: number): boolean {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const fieldId = readUint16LE(extra, offset);
    const size = readUint16LE(extra, offset + 2);
    offset += 4;
    if (offset + size > extra.length) return false;
    if (fieldId === id) return true;
    offset += size;
  }
  return false;
}

async function readEntryText(reader: ZipReader, name: string): Promise<string> {
  const entry = reader.entries().find((candidate) => candidate.name === name);
  assert.ok(entry, `missing entry ${name}`);
  const stream = await reader.open(entry);
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return new TextDecoder().decode(bytes);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function findSignatureFromEnd(buffer: Uint8Array, signature: number): number {
  for (let offset = buffer.length - 4; offset >= 0; offset -= 1) {
    if (readUint32LE(buffer, offset) === signature) {
      return offset;
    }
  }
  return -1;
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

function readUint64LE(buffer: Uint8Array, offset: number): bigint {
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getBigUint64(offset, true);
}

function writeUint32LE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
  buffer[offset + 3] = (value >>> 24) & 0xff;
}
