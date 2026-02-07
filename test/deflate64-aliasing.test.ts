import test from 'node:test';
import assert from 'node:assert/strict';
import { ZipReader } from '@ismail-elkorchi/bytefold/node/zip';

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

type RawEntry = {
  name: string;
  method: number;
  compressed: Uint8Array;
  uncompressed: Uint8Array;
};

function buildZip(entries: RawEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.uncompressed);
    const local = new Uint8Array(30 + nameBytes.length);
    writeUint32LE(local, 0, 0x04034b50);
    writeUint16LE(local, 4, 20);
    writeUint16LE(local, 6, 0x800);
    writeUint16LE(local, 8, entry.method);
    writeUint16LE(local, 10, 0);
    writeUint16LE(local, 12, 0);
    writeUint32LE(local, 14, crc);
    writeUint32LE(local, 18, entry.compressed.length);
    writeUint32LE(local, 22, entry.uncompressed.length);
    writeUint16LE(local, 26, nameBytes.length);
    writeUint16LE(local, 28, 0);
    local.set(nameBytes, 30);
    locals.push(local, entry.compressed);

    const central = new Uint8Array(46 + nameBytes.length);
    writeUint32LE(central, 0, 0x02014b50);
    writeUint16LE(central, 4, (3 << 8) | 20);
    writeUint16LE(central, 6, 20);
    writeUint16LE(central, 8, 0x800);
    writeUint16LE(central, 10, entry.method);
    writeUint16LE(central, 12, 0);
    writeUint16LE(central, 14, 0);
    writeUint32LE(central, 16, crc);
    writeUint32LE(central, 20, entry.compressed.length);
    writeUint32LE(central, 24, entry.uncompressed.length);
    writeUint16LE(central, 28, nameBytes.length);
    writeUint16LE(central, 30, 0);
    writeUint16LE(central, 32, 0);
    writeUint16LE(central, 34, 0);
    writeUint16LE(central, 36, 0);
    writeUint32LE(central, 38, 0);
    writeUint32LE(central, 42, offset);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length + entry.compressed.length;
  }

  const cdOffset = offset;
  const cdSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  writeUint32LE(eocd, 0, 0x06054b50);
  writeUint16LE(eocd, 4, 0);
  writeUint16LE(eocd, 6, 0);
  writeUint16LE(eocd, 8, entries.length);
  writeUint16LE(eocd, 10, entries.length);
  writeUint32LE(eocd, 12, cdSize);
  writeUint32LE(eocd, 16, cdOffset);
  writeUint16LE(eocd, 20, 0);

  return concat([...locals, ...centrals, eocd]);
}

class BitWriter {
  private bytes: number[] = [];
  private bitBuffer = 0;
  private bitCount = 0;

  writeBits(value: number, count: number): void {
    for (let i = 0; i < count; i += 1) {
      const bit = (value >>> i) & 1;
      this.bitBuffer |= bit << this.bitCount;
      this.bitCount += 1;
      if (this.bitCount === 8) {
        this.bytes.push(this.bitBuffer & 0xff);
        this.bitBuffer = 0;
        this.bitCount = 0;
      }
    }
  }

  writeBytes(chunk: Uint8Array): void {
    this.alignToByte();
    for (const byte of chunk) {
      this.bytes.push(byte);
    }
  }

  writeUint16LE(value: number): void {
    this.alignToByte();
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
  }

  alignToByte(): void {
    if (this.bitCount > 0) {
      this.bytes.push(this.bitBuffer & 0xff);
      this.bitBuffer = 0;
      this.bitCount = 0;
    }
  }

  finish(): Uint8Array {
    this.alignToByte();
    return new Uint8Array(this.bytes);
  }
}

const FIXED_LIT_LENGTHS = (() => {
  const lengths = new Array<number>(288).fill(0);
  for (let i = 0; i <= 143; i += 1) lengths[i] = 8;
  for (let i = 144; i <= 255; i += 1) lengths[i] = 9;
  for (let i = 256; i <= 279; i += 1) lengths[i] = 7;
  for (let i = 280; i <= 287; i += 1) lengths[i] = 8;
  return lengths;
})();

function reverseBits(value: number, length: number): number {
  let out = 0;
  let input = value;
  for (let i = 0; i < length; i += 1) {
    out = (out << 1) | (input & 1);
    input >>>= 1;
  }
  return out;
}

function buildCanonicalCodes(lengths: number[]): number[] {
  let maxLen = 0;
  for (const len of lengths) {
    if (len > maxLen) maxLen = len;
  }
  const blCount = new Array<number>(maxLen + 1).fill(0);
  for (const len of lengths) {
    if (len > 0) blCount[len] = (blCount[len] ?? 0) + 1;
  }
  const nextCode = new Array<number>(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits += 1) {
    code = (code + (blCount[bits - 1] ?? 0)) << 1;
    nextCode[bits] = code;
  }
  const codes = new Array<number>(lengths.length).fill(0);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const len = lengths[symbol]!;
    if (len === 0) continue;
    codes[symbol] = nextCode[len] ?? 0;
    nextCode[len] = (nextCode[len] ?? 0) + 1;
  }
  return codes;
}

const FIXED_CODES = buildCanonicalCodes(FIXED_LIT_LENGTHS);

function buildDeflate64DistanceStream(): Uint8Array {
  const writer = new BitWriter();
  const storedLen = 40000;
  const storedBytes = new Uint8Array(storedLen).fill(0x41);

  // Stored block (not final)
  writer.writeBits(0, 1);
  writer.writeBits(0, 2);
  writer.alignToByte();
  writer.writeUint16LE(storedLen);
  writer.writeUint16LE(storedLen ^ 0xffff);
  writer.writeBytes(storedBytes);

  // Fixed Huffman final block
  writer.writeBits(1, 1);
  writer.writeBits(1, 2);

  const lengthSymbol = 257; // length 3
  const lengthLen = FIXED_LIT_LENGTHS[lengthSymbol]!;
  const lengthCode = FIXED_CODES[lengthSymbol]!;
  writer.writeBits(reverseBits(lengthCode, lengthLen), lengthLen);

  const distanceSymbol = 30;
  writer.writeBits(reverseBits(distanceSymbol, 5), 5);
  const distance = 40000;
  const extra = distance - 32769;
  writer.writeBits(extra, 14);

  const endSymbol = 256;
  const endLen = FIXED_LIT_LENGTHS[endSymbol]!;
  const endCode = FIXED_CODES[endSymbol]!;
  writer.writeBits(reverseBits(endCode, endLen), endLen);

  return writer.finish();
}

test('deflate64 emitted chunks are immutable after enqueue', async () => {
  const compressed = buildDeflate64DistanceStream();
  const data = new Uint8Array(40003).fill(0x41);
  const zip = buildZip([
    {
      name: 'payload.bin',
      method: 9,
      compressed,
      uncompressed: data
    }
  ]);

  const reader = await ZipReader.fromUint8Array(zip, {
    limits: { maxCompressionRatio: 100000 }
  });
  const entry = reader.entries()[0]!;
  const stream = await reader.open(entry);
  const streamReader = stream.getReader();

  const first = await streamReader.read();
  assert.ok(!first.done && first.value && first.value.length > 0);
  const snapshot = new Uint8Array(first.value);

  let chunks = 1;
  while (true) {
    const { value, done } = await streamReader.read();
    if (done) break;
    if (value && value.length > 0) chunks += 1;
  }

  assert.ok(chunks > 1, 'expected multiple output chunks');
  assert.deepEqual(first.value, snapshot);
});
