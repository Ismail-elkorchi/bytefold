import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const fixturesRoot = resolve(fileURLToPath(new URL('../test/fixtures/', import.meta.url)));

const xzBasePath = resolve(fixturesRoot, 'hello.txt.xz');
const xzOutPath = resolve(fixturesRoot, 'concat-limit.xz');
const xzConcatPath = resolve(fixturesRoot, 'concat-two.xz');
const xzPaddingPath = resolve(fixturesRoot, 'xz-padding-4m.xz');
const xzHugeDictPath = resolve(fixturesRoot, 'xz-dict-huge.xz');
const bz2BasePath = resolve(fixturesRoot, 'hello.txt.bz2');
const bz2OutPath = resolve(fixturesRoot, 'concat-limit.bz2');

function findLzma2PropsOffset(data) {
  if (data.length < 12) return null;
  const headerSizeByte = data[12];
  if (headerSizeByte === undefined || headerSizeByte === 0x00) return null;
  const headerSize = (headerSizeByte + 1) * 4;
  const headerOffset = 12;
  const headerEnd = headerOffset + headerSize;
  if (headerEnd > data.length) return null;
  const header = data.subarray(headerOffset, headerEnd);
  const storedCrc = readUint32LE(header, header.length - 4);
  const crc = crc32(header.subarray(0, header.length - 4));
  if (crc !== storedCrc) return null;
  let offset = 1;
  const flags = header[offset++];
  if ((flags & 0x3c) !== 0) return null;
  const filterCount = (flags & 0x03) + 1;
  if (filterCount > 4) return null;
  if (flags & 0x40) {
    const read = readVli(header, offset, header.length - 4);
    if (!read) return null;
    offset = read.offset;
  }
  if (flags & 0x80) {
    const read = readVli(header, offset, header.length - 4);
    if (!read) return null;
    offset = read.offset;
  }
  let dictProp = null;
  let propsOffset = null;
  let lastFilter = null;
  for (let i = 0; i < filterCount; i += 1) {
    const id = readVli(header, offset, header.length - 4);
    if (!id) return null;
    offset = id.offset;
    const propsSize = readVli(header, offset, header.length - 4);
    if (!propsSize) return null;
    offset = propsSize.offset;
    const size = Number(propsSize.value);
    if (!Number.isFinite(size)) return null;
    if (offset + size > header.length - 4) return null;
    if (id.value === 0x21n) {
      if (size !== 1) return null;
      propsOffset = headerOffset + offset;
      dictProp = header[offset];
    }
    offset += size;
    lastFilter = id.value;
  }
  if (lastFilter !== 0x21n || dictProp === null || propsOffset === null) return null;
  return { propsOffset, dictProp, headerOffset, headerSize };
}

function selectLargerDictionaryProp(currentSize) {
  const candidates = [];
  for (let prop = 0; prop <= 40; prop += 1) {
    const size = decodeDictionarySize(prop);
    if (size > currentSize) candidates.push({ prop, size });
  }
  candidates.sort((a, b) => a.size - b.size);
  const maxTarget = 32 * 1024 * 1024;
  return candidates.find((item) => item.size <= maxTarget) ?? candidates[0];
}

function selectDictionaryPropAtLeast(minSize) {
  let best = null;
  for (let prop = 0; prop <= 40; prop += 1) {
    const size = decodeDictionarySize(prop);
    if (size >= minSize && (!best || size < best.size)) {
      best = { prop, size };
    }
  }
  if (best) return best;
  const fallback = decodeDictionarySize(40);
  return { prop: 40, size: fallback };
}

function updateBlockHeaderCrc(data, headerOffset, headerSize) {
  const header = data.subarray(headerOffset, headerOffset + headerSize);
  const crc = crc32(header.subarray(0, header.length - 4));
  writeUint32LE(header, header.length - 4, crc);
}

function decodeDictionarySize(props) {
  const bits = props & 0x3f;
  if (bits > 40) return 0;
  if (bits === 40) return 0xffffffff;
  const base = 2 | (bits & 1);
  const shift = (bits >> 1) + 11;
  return base * 2 ** shift;
}

function readVli(buffer, start, end) {
  let offset = start;
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < 9; i += 1) {
    if (offset >= end) return null;
    const byte = buffer[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  return null;
}

function readUint32LE(buf, offset) {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

function writeUint32LE(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
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

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      if ((c & 1) !== 0) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(chunk) {
  let crc = 0xffffffff;
  for (let i = 0; i < chunk.length; i += 1) {
    crc = TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function main() {
  const xzBase = new Uint8Array(await readFile(xzBasePath));
  const xzInfo = findLzma2PropsOffset(xzBase);
  if (!xzInfo) {
    throw new Error('Unable to locate LZMA2 props in hello.txt.xz');
  }
  const currentSize = decodeDictionarySize(xzInfo.dictProp);
  const nextProp = selectLargerDictionaryProp(currentSize);
  const xzModified = new Uint8Array(xzBase);
  xzModified[xzInfo.propsOffset] = nextProp.prop;
  updateBlockHeaderCrc(xzModified, xzInfo.headerOffset, xzInfo.headerSize);
  const streamPadding = new Uint8Array(4);
  const xzConcat = concatBytes([xzBase, streamPadding, xzModified]);
  await writeFile(xzOutPath, xzConcat);
  const xzTwo = concatBytes([xzBase, streamPadding, xzBase]);
  await writeFile(xzConcatPath, xzTwo);

  const largePadding = new Uint8Array(4 * 1024 * 1024);
  const xzPadded = concatBytes([xzBase, largePadding]);
  await writeFile(xzPaddingPath, xzPadded);

  const hugeTarget = 128 * 1024 * 1024;
  const hugeProp = selectDictionaryPropAtLeast(hugeTarget);
  const xzHugeStream = new Uint8Array(xzBase);
  xzHugeStream[xzInfo.propsOffset] = hugeProp.prop;
  updateBlockHeaderCrc(xzHugeStream, xzInfo.headerOffset, xzInfo.headerSize);
  const prefixTarget = 4 * 1024 * 1024;
  const repeats = Math.max(0, Math.ceil((prefixTarget - xzHugeStream.length) / xzBase.length));
  const chunks = [];
  for (let i = 0; i < repeats; i += 1) {
    chunks.push(xzBase);
  }
  chunks.push(xzHugeStream);
  const xzHuge = concatBytes(chunks);
  await writeFile(xzHugeDictPath, xzHuge);

  const bz2Base = new Uint8Array(await readFile(bz2BasePath));
  if (bz2Base.length < 4 || bz2Base[0] !== 0x42 || bz2Base[1] !== 0x5a || bz2Base[2] !== 0x68) {
    throw new Error('Unexpected bzip2 fixture header');
  }
  const bz2MemberA = new Uint8Array(bz2Base);
  bz2MemberA[3] = 0x31;
  const bz2Concat = concatBytes([bz2MemberA, bz2Base]);
  await writeFile(bz2OutPath, bz2Concat);
}

await main();
