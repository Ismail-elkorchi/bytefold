import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const fixturesRoot = resolve(fileURLToPath(new URL('../test/fixtures/', import.meta.url)));
const expectedRoot = resolve(fixturesRoot, 'expected');

const HEADER_MAGIC = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const FOOTER_MAGIC = new Uint8Array([0x59, 0x5a]);

const FILTER_LZMA2 = 0x21n;
const CHECK_CRC32 = 0x01;
const DICT_PROP = 0; // 4 KiB dictionary

const BLOCK_COUNT = 8;
const PAYLOAD_SIZE = 32760;

const CRC_TABLE = (() => {
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

const blocks = [];
const payloads = [];

for (let i = 0; i < BLOCK_COUNT; i += 1) {
  const payload = new Uint8Array(PAYLOAD_SIZE);
  payload.fill(0x41 + (i % 26));
  payloads.push(payload);
  blocks.push(
    buildBlock({
      payload,
      filters: [{ id: FILTER_LZMA2, props: new Uint8Array([DICT_PROP]) }],
      checkType: CHECK_CRC32
    })
  );
}

const stream = buildStream(blocks, CHECK_CRC32);
const expected = concatBytes(payloads);

await mkdir(expectedRoot, { recursive: true });
await writeFile(resolve(fixturesRoot, 'xz-many-blocks.xz'), stream);
await writeFile(resolve(expectedRoot, 'xz-many-blocks.bin'), expected);

function buildBlock({ payload, filters, checkType }) {
  const blockHdr = blockHeader(filters);
  const lzma2Data = encodeLzma2Uncompressed(payload);
  const padLen = (4 - (lzma2Data.length % 4)) & 3;
  const blockPad = new Uint8Array(padLen);
  const check = buildCheck(checkType, payload);
  const block = concatBytes([blockHdr, lzma2Data, blockPad, check]);
  const unpaddedSize = BigInt(blockHdr.length + lzma2Data.length + check.length);
  return { block, unpaddedSize, uncompressedSize: BigInt(payload.length) };
}

function buildStream(blocks, checkType) {
  const headerFlags = new Uint8Array([0x00, checkType & 0x0f]);
  const headerCrc = crc32(headerFlags);
  const headerCrcBytes = new Uint8Array(4);
  writeUint32LE(headerCrcBytes, 0, headerCrc);
  const streamHeader = concatBytes([HEADER_MAGIC, headerFlags, headerCrcBytes]);

  const blockBytes = blocks.map((block) => block.block);
  const index = buildIndex(blocks);

  const backwardSize = index.length / 4 - 1;
  const footerBody = new Uint8Array(6);
  writeUint32LE(footerBody, 0, backwardSize);
  footerBody[4] = headerFlags[0];
  footerBody[5] = headerFlags[1];
  const footerCrc = crc32(footerBody);
  const footer = new Uint8Array(12);
  writeUint32LE(footer, 0, footerCrc);
  footer.set(footerBody, 4);
  footer.set(FOOTER_MAGIC, 10);

  return concatBytes([streamHeader, ...blockBytes, index, footer]);
}

function buildIndex(blocks) {
  const records = [];
  for (const block of blocks) {
    records.push(encodeVli(block.unpaddedSize));
    records.push(encodeVli(block.uncompressedSize));
  }
  const indexBody = concatBytes([new Uint8Array([0x00]), encodeVli(BigInt(blocks.length)), ...records]);
  const padding = (4 - (indexBody.length % 4)) & 3;
  const indexPadded = concatBytes([indexBody, new Uint8Array(padding)]);
  const crc = crc32(indexPadded);
  const crcBytes = new Uint8Array(4);
  writeUint32LE(crcBytes, 0, crc);
  return concatBytes([indexPadded, crcBytes]);
}

function encodeLzma2Uncompressed(payload) {
  if (payload.length === 0 || payload.length > 0x10000) {
    throw new Error('payload size must be 1..65536 for uncompressed chunk');
  }
  const size = payload.length - 1;
  const header = new Uint8Array([0x01, (size >>> 8) & 0xff, size & 0xff]);
  return concatBytes([header, payload, new Uint8Array([0x00])]);
}

function blockHeader(filters) {
  if (filters.length === 0 || filters.length > 4) {
    throw new Error('invalid filter count');
  }
  const parts = [];
  const flags = (filters.length - 1) & 0x03;
  parts.push(flags);
  for (const filter of filters) {
    parts.push(...encodeVli(filter.id));
    parts.push(...encodeVli(filter.props.length));
    parts.push(...filter.props);
  }
  const required = 1 + parts.length + 4;
  const headerSize = Math.max(8, Math.ceil(required / 4) * 4);
  const header = new Uint8Array(headerSize);
  header[0] = headerSize / 4 - 1;
  header.set(parts, 1);
  const crc = crc32(header.subarray(0, header.length - 4));
  writeUint32LE(header, header.length - 4, crc);
  return header;
}

function buildCheck(checkType, payload) {
  if (checkType !== CHECK_CRC32) {
    throw new Error(`unsupported check type ${checkType}`);
  }
  const value = crc32(payload);
  const out = new Uint8Array(4);
  writeUint32LE(out, 0, value);
  return out;
}

function encodeVli(value) {
  let v = BigInt(value);
  const out = [];
  while (true) {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
    if (v === 0n) break;
  }
  return Uint8Array.from(out);
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

function writeUint32LE(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
