import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ZipReader, ZipWriter, ZipError } from 'archive-shield/node/zip';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(chunk: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < chunk.length; i += 1) {
    crc = CRC_TABLE[(crc ^ chunk[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
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

test('seekable patch mode writes local header sizes and omits data descriptor', async () => {
  const data = new TextEncoder().encode('seekable');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  });

  const filePath = path.join(tmpdir(), `archive-shield-seekable-${Date.now()}.zip`);
  const writer = await ZipWriter.toFile(filePath, { seekable: 'on' });
  await writer.add('file.txt', stream, { method: 0 });
  await writer.close();

  const zip = new Uint8Array(await readFile(filePath));
  assert.equal(readUint32LE(zip, 0), 0x04034b50);

  const flags = readUint16LE(zip, 6);
  assert.equal(flags & 0x08, 0, 'data descriptor flag should be clear');

  const headerCrc = readUint32LE(zip, 14);
  const headerCompressed = readUint32LE(zip, 18);
  const headerUncompressed = readUint32LE(zip, 22);

  assert.equal(headerCrc, crc32(data));
  assert.equal(headerCompressed, data.length);
  assert.equal(headerUncompressed, data.length);

  const nameLen = readUint16LE(zip, 26);
  const extraLen = readUint16LE(zip, 28);
  const dataOffset = 30 + nameLen + extraLen;
  const afterData = dataOffset + headerCompressed;
  assert.notEqual(readUint32LE(zip, afterData), 0x08074b50);

  const reader = await ZipReader.fromFile(filePath);
  const entry = reader.entries()[0]!;
  const entryStream = await reader.open(entry);
  const buf = await new Response(entryStream).arrayBuffer();
  assert.deepEqual(new Uint8Array(buf), data);
  await reader.close();
});

test('seekable patch mode requires ZIP64 when sizes exceed 4GiB', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    }
  });

  const filePath = path.join(tmpdir(), `archive-shield-zip64-required-${Date.now()}.zip`);
  const writer = await ZipWriter.toFile(filePath, { seekable: 'on' });

  try {
    await assert.rejects(async () => {
      await writer.add('big.bin', stream, {
        zip64: 'auto',
        declaredUncompressedSize: 0x1_0000_0000n
      } as any);
    }, (err: unknown) => err instanceof ZipError && err.code === 'ZIP_ZIP64_REQUIRED');
  } finally {
    await writer.close().catch(() => {});
  }
});
