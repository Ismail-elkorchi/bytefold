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

function writeUint16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
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

function buildUnicodeExtra(rawBytes: Uint8Array, unicodeName: string, crcOverride?: number): Uint8Array {
  const utf8 = new TextEncoder().encode(unicodeName);
  const dataSize = 1 + 4 + utf8.length;
  const out = new Uint8Array(4 + dataSize);
  writeUint16LE(out, 0, 0x7075);
  writeUint16LE(out, 2, dataSize);
  out[4] = 1;
  const crc = crcOverride ?? crc32(rawBytes);
  writeUint32LE(out, 5, crc);
  out.set(utf8, 9);
  return out;
}

function buildUnicodeCommentExtra(rawBytes: Uint8Array, unicodeComment: string): Uint8Array {
  const utf8 = new TextEncoder().encode(unicodeComment);
  const dataSize = 1 + 4 + utf8.length;
  const out = new Uint8Array(4 + dataSize);
  writeUint16LE(out, 0, 0x6375);
  writeUint16LE(out, 2, dataSize);
  out[4] = 1;
  writeUint32LE(out, 5, crc32(rawBytes));
  out.set(utf8, 9);
  return out;
}

function buildUnicodeZip(): Uint8Array {
  const encoder = new TextEncoder();
  const entries = [
    {
      rawName: 'plain.txt',
      unicodeName: 'snow-雪.txt',
      data: encoder.encode('hello'),
      rawComment: 'plain-comment',
      unicodeComment: 'note-雪'
    },
    {
      rawName: 'bad.txt',
      unicodeName: 'bad-雪.txt',
      data: encoder.encode('bad'),
      rawComment: ''
    }
  ];

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.rawName);
    const dataBytes = entry.data;
    const dataCrc = crc32(dataBytes);

    const extraFields: Uint8Array[] = [];
    if (entry.rawName === 'plain.txt') {
      extraFields.push(buildUnicodeExtra(nameBytes, entry.unicodeName));
      extraFields.push(buildUnicodeCommentExtra(encoder.encode(entry.rawComment), entry.unicodeComment!));
    } else {
      extraFields.push(buildUnicodeExtra(nameBytes, entry.unicodeName, (crc32(nameBytes) + 1) >>> 0));
    }
    const extra = concat(extraFields);

    const lfh = new Uint8Array(30 + nameBytes.length + extra.length);
    writeUint32LE(lfh, 0, 0x04034b50);
    writeUint16LE(lfh, 4, 20);
    writeUint16LE(lfh, 6, 0);
    writeUint16LE(lfh, 8, 0);
    writeUint16LE(lfh, 10, 0);
    writeUint16LE(lfh, 12, 0);
    writeUint32LE(lfh, 14, dataCrc);
    writeUint32LE(lfh, 18, dataBytes.length);
    writeUint32LE(lfh, 22, dataBytes.length);
    writeUint16LE(lfh, 26, nameBytes.length);
    writeUint16LE(lfh, 28, extra.length);
    lfh.set(nameBytes, 30);
    lfh.set(extra, 30 + nameBytes.length);

    localParts.push(lfh, dataBytes);

    const commentBytes = encoder.encode(entry.rawComment ?? '');
    const cdfh = new Uint8Array(46 + nameBytes.length + extra.length + commentBytes.length);
    writeUint32LE(cdfh, 0, 0x02014b50);
    writeUint16LE(cdfh, 4, (3 << 8) | 20);
    writeUint16LE(cdfh, 6, 20);
    writeUint16LE(cdfh, 8, 0);
    writeUint16LE(cdfh, 10, 0);
    writeUint16LE(cdfh, 12, 0);
    writeUint16LE(cdfh, 14, 0);
    writeUint32LE(cdfh, 16, dataCrc);
    writeUint32LE(cdfh, 20, dataBytes.length);
    writeUint32LE(cdfh, 24, dataBytes.length);
    writeUint16LE(cdfh, 28, nameBytes.length);
    writeUint16LE(cdfh, 30, extra.length);
    writeUint16LE(cdfh, 32, commentBytes.length);
    writeUint16LE(cdfh, 34, 0);
    writeUint16LE(cdfh, 36, 0);
    writeUint32LE(cdfh, 38, 0);
    writeUint32LE(cdfh, 42, offset);
    cdfh.set(nameBytes, 46);
    cdfh.set(extra, 46 + nameBytes.length);
    cdfh.set(commentBytes, 46 + nameBytes.length + extra.length);

    centralParts.push(cdfh);

    offset += lfh.length + dataBytes.length;
  }

  const cdOffset = offset;
  const cdSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  writeUint32LE(eocd, 0, 0x06054b50);
  writeUint16LE(eocd, 4, 0);
  writeUint16LE(eocd, 6, 0);
  writeUint16LE(eocd, 8, entries.length);
  writeUint16LE(eocd, 10, entries.length);
  writeUint32LE(eocd, 12, cdSize);
  writeUint32LE(eocd, 16, cdOffset);
  writeUint16LE(eocd, 20, 0);

  return concat([...localParts, ...centralParts, eocd]);
}

test('Info-ZIP Unicode path and comment extra fields are honored', async () => {
  const zip = buildUnicodeZip();
  const reader = await ZipReader.fromUint8Array(zip);
  const entries = reader.entries();

  const unicodeEntry = entries.find((entry) => entry.rawNameBytes && entry.rawNameBytes.length && entry.name !== 'bad.txt');
  assert.ok(unicodeEntry);
  assert.equal(unicodeEntry.name, 'snow-雪.txt');
  assert.equal(unicodeEntry.nameSource, 'unicode-extra');
  assert.equal(unicodeEntry.comment, 'note-雪');

  const fallbackEntry = entries.find((entry) => entry.name === 'bad.txt');
  assert.ok(fallbackEntry);
  assert.equal(fallbackEntry.nameSource, 'cp437');
});
