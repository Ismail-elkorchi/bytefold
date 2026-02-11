import test from 'node:test';
import assert from 'node:assert/strict';
import { ZipError, ZipReader, ZipWriter } from '@ismail-elkorchi/bytefold/node/zip';

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD_SIGNATURE = 0x06054b50;
const UINT32_MAX = 0xffffffff;
const UINT32_MAX_PLUS_ONE = 0x1_0000_0000n;

test('zip64 boundary: central directory offset > uint32 rejects without truncation', async () => {
  const zip = await writeZipFixture({ shouldForceZip64: true });
  const zip64EocdOffset = findSignature(zip, ZIP64_EOCD_SIGNATURE);
  assert.ok(zip64EocdOffset >= 0, 'missing ZIP64 EOCD');

  writeUint64LE(zip, zip64EocdOffset + 48, UINT32_MAX_PLUS_ONE);

  await assert.rejects(
    () => ZipReader.fromUint8Array(zip),
    (error: unknown) => error instanceof ZipError && error.code === 'ZIP_TRUNCATED'
  );
});

test('zip64 boundary: EOCD sentinel without ZIP64 locator is rejected', async () => {
  const zip = await writeZipFixture({ shouldForceZip64: true });
  const locatorOffset = findSignature(zip, ZIP64_LOCATOR_SIGNATURE);
  assert.ok(locatorOffset >= 0, 'missing ZIP64 locator');

  writeUint32LE(zip, locatorOffset, 0);

  await assert.rejects(
    () => ZipReader.fromUint8Array(zip),
    (error: unknown) => error instanceof ZipError && error.code === 'ZIP_BAD_ZIP64'
  );
});

test('zip64 boundary: EOCD sentinel without ZIP64 EOCD record is rejected', async () => {
  const zip = await writeZipFixture({ shouldForceZip64: true });
  const zip64EocdOffset = findSignature(zip, ZIP64_EOCD_SIGNATURE);
  assert.ok(zip64EocdOffset >= 0, 'missing ZIP64 EOCD');

  writeUint32LE(zip, zip64EocdOffset, 0);

  await assert.rejects(
    () => ZipReader.fromUint8Array(zip),
    (error: unknown) => error instanceof ZipError && error.code === 'ZIP_BAD_ZIP64'
  );
});

test('zip64 boundary: malformed ZIP64 extra field yields typed ZIP_BAD_ZIP64', async () => {
  const zip = await writeZipFixture({ shouldForceZip64: true });
  const centralDirectoryOffset = findSignature(zip, CENTRAL_DIRECTORY_SIGNATURE);
  assert.ok(centralDirectoryOffset >= 0, 'missing central directory header');

  const fileNameLength = readUint16LE(zip, centralDirectoryOffset + 28);
  const extraOffset = centralDirectoryOffset + 46 + fileNameLength;

  writeUint16LE(zip, centralDirectoryOffset + 30, 4); // keep only Zip64 extra header id+size
  writeUint16LE(zip, extraOffset + 2, 0); // malformed: no required Zip64 payload

  await assert.rejects(
    () => ZipReader.fromUint8Array(zip),
    (error: unknown) => error instanceof ZipError && error.code === 'ZIP_BAD_ZIP64'
  );
});

test('zip64 boundary: uint32 sentinel in EOCD without Zip64 structures rejects deterministically', async () => {
  const zip = await writeZipFixture();
  const eocdOffset = findSignatureFromEnd(zip, EOCD_SIGNATURE);
  assert.ok(eocdOffset >= 0, 'missing EOCD');

  writeUint32LE(zip, eocdOffset + 12, UINT32_MAX); // cdSize32
  writeUint32LE(zip, eocdOffset + 16, UINT32_MAX); // cdOffset32

  await assert.rejects(
    () => ZipReader.fromUint8Array(zip),
    (error: unknown) => error instanceof ZipError && error.code === 'ZIP_BAD_ZIP64'
  );
});

async function writeZipFixture(options?: { shouldForceZip64?: boolean }): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const writer = ZipWriter.toWritable(writable, options);
  await writer.add('hello.txt', new TextEncoder().encode('zip64-boundary'), { method: 0 });
  await writer.close();
  return concat(chunks);
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

function findSignature(buffer: Uint8Array, signature: number): number {
  for (let offset = 0; offset <= buffer.length - 4; offset += 1) {
    if (readUint32LE(buffer, offset) === signature) {
      return offset;
    }
  }
  return -1;
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

function writeUint16LE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32LE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
  buffer[offset + 3] = (value >>> 24) & 0xff;
}

function writeUint64LE(buffer: Uint8Array, offset: number, value: bigint): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  view.setBigUint64(offset, value, true);
}
