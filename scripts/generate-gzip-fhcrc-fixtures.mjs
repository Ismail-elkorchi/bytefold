import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (~crc) >>> 0;
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

function writeU32LE(buffer, offset, value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
  buffer[offset + 3] = (value >>> 24) & 0xff;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const payloadPath = path.join(repoRoot, 'test', 'fixtures', 'expected', 'hello.txt');
const okPath = path.join(repoRoot, 'test', 'fixtures', 'gzip-fhcrc-ok.gz');
const badPath = path.join(repoRoot, 'test', 'fixtures', 'gzip-fhcrc-bad.gz');

const payload = new Uint8Array(await readFile(payloadPath));
const compressed = new Uint8Array(deflateRawSync(payload, { level: 9 }));

const encoder = new TextEncoder();
const fname = encoder.encode('hello.txt');

const FLG_FHCRC = 0x02;
const FLG_FNAME = 0x08;
const flg = FLG_FHCRC | FLG_FNAME;

const header = new Uint8Array(10);
header[0] = 0x1f;
header[1] = 0x8b;
header[2] = 0x08;
header[3] = flg;
header[4] = 0x00;
header[5] = 0x00;
header[6] = 0x00;
header[7] = 0x00;
header[8] = 0x00;
header[9] = 0xff;

const headerBytes = concatBytes([header, fname, new Uint8Array([0x00])]);
const crc = crc32(headerBytes) & 0xffff;
const fhcrcOk = new Uint8Array([crc & 0xff, (crc >>> 8) & 0xff]);
const fhcrcBad = new Uint8Array([fhcrcOk[0] ^ 0xff, fhcrcOk[1]]);

const trailer = new Uint8Array(8);
writeU32LE(trailer, 0, crc32(payload));
writeU32LE(trailer, 4, payload.length >>> 0);

const ok = concatBytes([headerBytes, fhcrcOk, compressed, trailer]);
const bad = concatBytes([headerBytes, fhcrcBad, compressed, trailer]);

await writeFile(okPath, ok);
await writeFile(badPath, bad);
