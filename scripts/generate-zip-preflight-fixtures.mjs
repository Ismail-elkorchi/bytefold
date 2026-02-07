import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (~crc) >>> 0;
}

function writeU16LE(buffer, offset, value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32LE(buffer, offset, value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
  buffer[offset + 3] = (value >>> 24) & 0xff;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function buildZip({ multiDisk }) {
  const encoder = new TextEncoder();
  const name = encoder.encode('hello.txt');
  const data = encoder.encode('hello');
  const crc = crc32(data);
  const localHeader = new Uint8Array(30 + name.length);
  writeU32LE(localHeader, 0, 0x04034b50);
  writeU16LE(localHeader, 4, 20);
  writeU16LE(localHeader, 6, 0);
  writeU16LE(localHeader, 8, 0);
  writeU16LE(localHeader, 10, 0);
  writeU16LE(localHeader, 12, 0);
  writeU32LE(localHeader, 14, crc);
  writeU32LE(localHeader, 18, data.length);
  writeU32LE(localHeader, 22, data.length);
  writeU16LE(localHeader, 26, name.length);
  writeU16LE(localHeader, 28, 0);
  localHeader.set(name, 30);

  const cdHeader = new Uint8Array(46 + name.length);
  writeU32LE(cdHeader, 0, 0x02014b50);
  writeU16LE(cdHeader, 4, 20);
  writeU16LE(cdHeader, 6, 20);
  writeU16LE(cdHeader, 8, 0);
  writeU16LE(cdHeader, 10, 0);
  writeU16LE(cdHeader, 12, 0);
  writeU16LE(cdHeader, 14, 0);
  writeU32LE(cdHeader, 16, crc);
  writeU32LE(cdHeader, 20, data.length);
  writeU32LE(cdHeader, 24, data.length);
  writeU16LE(cdHeader, 28, name.length);
  writeU16LE(cdHeader, 30, 0);
  writeU16LE(cdHeader, 32, 0);
  writeU16LE(cdHeader, 34, multiDisk ? 1 : 0);
  writeU16LE(cdHeader, 36, 0);
  writeU32LE(cdHeader, 38, 0);
  writeU32LE(cdHeader, 42, 0);
  cdHeader.set(name, 46);

  const cdOffset = localHeader.length + data.length;
  const cdSize = cdHeader.length;

  const eocd = new Uint8Array(22);
  writeU32LE(eocd, 0, 0x06054b50);
  writeU16LE(eocd, 4, multiDisk ? 1 : 0);
  writeU16LE(eocd, 6, multiDisk ? 1 : 0);
  writeU16LE(eocd, 8, 1);
  writeU16LE(eocd, 10, 1);
  writeU32LE(eocd, 12, cdSize);
  writeU32LE(eocd, 16, cdOffset);
  writeU16LE(eocd, 20, 0);

  return concatBytes([localHeader, data, cdHeader, eocd]);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(repoRoot, 'test', 'fixtures', 'zip-preflight');
await mkdir(fixtureDir, { recursive: true });

const basic = buildZip({ multiDisk: false });
const multiDisk = buildZip({ multiDisk: true });

await writeFile(path.join(fixtureDir, 'basic.zip'), basic);
await writeFile(path.join(fixtureDir, 'multi-disk.zip'), multiDisk);
