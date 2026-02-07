import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const fixturesRoot = resolve(fileURLToPath(new URL('../test/fixtures/', import.meta.url)));
const bcjRoot = resolve(fixturesRoot, 'xz-bcj');
const expectedRoot = resolve(fixturesRoot, 'expected');

const HEADER_MAGIC = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const FOOTER_MAGIC = new Uint8Array([0x59, 0x5a]);

const FILTER_X86 = 0x04n;
const FILTER_POWERPC = 0x05n;
const FILTER_IA64 = 0x06n;
const FILTER_ARM = 0x07n;
const FILTER_ARMTHUMB = 0x08n;
const FILTER_SPARC = 0x09n;
const FILTER_ARM64 = 0x0an;
const FILTER_RISCV = 0x0bn;
const FILTER_LZMA2 = 0x21n;

const CHECK_CRC32 = 0x01;
const CHECK_SHA256 = 0x0a;

const DICT_PROP = 0; // 4 KiB dictionary

const encoder = new TextEncoder();

const FIXTURES = [
  {
    path: 'xz-bcj/x86.xz',
    expected: 'xz-bcj-x86.bin',
    payload: encoder.encode('bytefold bcj x86 fixture\n'),
    filters: [
      { id: FILTER_X86, props: uint32le(0) },
      { id: FILTER_LZMA2, props: new Uint8Array([DICT_PROP]) }
    ],
    checkType: CHECK_CRC32
  },
  {
    path: 'xz-bcj/arm.xz',
    expected: 'xz-bcj-arm.bin',
    payload: encoder.encode('bytefold bcj arm fixture\n'),
    filters: [
      { id: FILTER_ARM, props: uint32le(0) },
      { id: FILTER_LZMA2, props: new Uint8Array([DICT_PROP]) }
    ],
    checkType: CHECK_CRC32
  },
  {
    path: 'xz-bcj/arm64.xz',
    expected: 'xz-bcj-arm64.bin',
    payload: encoder.encode('bytefold bcj arm64 fixture\n'),
    filters: [
      { id: FILTER_ARM64, props: uint32le(0) },
      { id: FILTER_LZMA2, props: new Uint8Array([DICT_PROP]) }
    ],
    checkType: CHECK_CRC32
  },
  {
    path: 'xz-bcj/riscv.xz',
    expected: 'xz-bcj-riscv.bin',
    payload: encoder.encode('bytefold bcj riscv fixture\n'),
    filters: [
      { id: FILTER_RISCV, props: uint32le(0) },
      { id: FILTER_LZMA2, props: new Uint8Array([DICT_PROP]) }
    ],
    checkType: CHECK_CRC32
  },
  {
    path: 'xz-bcj/powerpc.xz',
    expected: 'xz-bcj-powerpc.bin',
    payload: buildPowerpcPayload(),
    filters: [
      { id: FILTER_POWERPC, props: uint32le(0) },
      { id: FILTER_LZMA2, props: new Uint8Array([DICT_PROP]) }
    ],
    checkType: CHECK_CRC32,
    bcjId: FILTER_POWERPC
  },
  {
    path: 'xz-bcj/ia64.xz',
    expected: 'xz-bcj-ia64.bin',
    payload: buildIa64Payload(),
    filters: [
      { id: FILTER_IA64, props: uint32le(0) },
      { id: FILTER_LZMA2, props: new Uint8Array([DICT_PROP]) }
    ],
    checkType: CHECK_CRC32,
    bcjId: FILTER_IA64
  },
  {
    path: 'xz-bcj/armthumb.xz',
    expected: 'xz-bcj-armthumb.bin',
    payload: buildArmThumbPayload(),
    filters: [
      { id: FILTER_ARMTHUMB, props: uint32le(0) },
      { id: FILTER_LZMA2, props: new Uint8Array([DICT_PROP]) }
    ],
    checkType: CHECK_CRC32,
    bcjId: FILTER_ARMTHUMB
  },
  {
    path: 'xz-bcj/sparc.xz',
    expected: 'xz-bcj-sparc.bin',
    payload: buildSparcPayload(),
    filters: [
      { id: FILTER_SPARC, props: uint32le(0) },
      { id: FILTER_LZMA2, props: new Uint8Array([DICT_PROP]) }
    ],
    checkType: CHECK_CRC32,
    bcjId: FILTER_SPARC
  },
  {
    path: 'xz-check-sha256.xz',
    expected: 'xz-check-sha256.bin',
    payload: encoder.encode('bytefold sha256 check fixture\n'),
    filters: [{ id: FILTER_LZMA2, props: new Uint8Array([DICT_PROP]) }],
    checkType: CHECK_SHA256
  }
];

const BCJ_ENCODERS = new Map([
  [FILTER_POWERPC, powerpcCode],
  [FILTER_IA64, ia64Code],
  [FILTER_ARMTHUMB, armthumbCode],
  [FILTER_SPARC, sparcCode]
]);

function buildPowerpcPayload() {
  const payload = new Uint8Array(12);
  payload[4] = 0x48;
  payload[7] = 0x01;
  return payload;
}

function buildArmThumbPayload() {
  const payload = new Uint8Array(8);
  payload[2] = 0x00;
  payload[3] = 0xf0;
  payload[4] = 0x00;
  payload[5] = 0xf8;
  return payload;
}

function buildSparcPayload() {
  const payload = new Uint8Array(12);
  payload[4] = 0x40;
  payload[7] = 0x01;
  return payload;
}

function buildIa64Payload() {
  const payload = new Uint8Array(32);
  const bundle = buildIa64Bundle(16, 2, 0x12345);
  payload.set(bundle, 16);
  return payload;
}

function buildIa64Bundle(template, slot, displacement) {
  const bundle = new Uint8Array(16);
  bundle[0] = template & 0x1f;
  const bitPos = 5 + 41 * slot;
  const bytePos = bitPos >> 3;
  const bitRes = bitPos & 0x7;
  let instNorm = 0n;
  instNorm |= 0x5n << 37n;
  instNorm |= BigInt(displacement & 0xfffff) << 13n;
  instNorm |= BigInt((displacement >> 20) & 1) << 36n;
  const instruction = instNorm << BigInt(bitRes);
  for (let j = 0; j < 6; j += 1) {
    bundle[bytePos + j] = Number((instruction >> BigInt(8 * j)) & 0xffn);
  }
  return bundle;
}

function uint32le(value) {
  const out = new Uint8Array(4);
  out[0] = value & 0xff;
  out[1] = (value >>> 8) & 0xff;
  out[2] = (value >>> 16) & 0xff;
  out[3] = (value >>> 24) & 0xff;
  return out;
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

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

class Sha256 {
  constructor() {
    this.state = new Uint32Array(8);
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.bytesLow = 0;
    this.bytesHigh = 0;
    this.finished = false;
    this.reset();
  }

  reset() {
    this.state[0] = 0x6a09e667;
    this.state[1] = 0xbb67ae85;
    this.state[2] = 0x3c6ef372;
    this.state[3] = 0xa54ff53a;
    this.state[4] = 0x510e527f;
    this.state[5] = 0x9b05688c;
    this.state[6] = 0x1f83d9ab;
    this.state[7] = 0x5be0cd19;
    this.bufferLength = 0;
    this.bytesLow = 0;
    this.bytesHigh = 0;
    this.finished = false;
  }

  update(data) {
    if (this.finished) {
      throw new Error('SHA-256: cannot update after digest');
    }
    let offset = 0;
    this.addBytes(data.length);
    while (offset < data.length) {
      const space = 64 - this.bufferLength;
      const take = Math.min(space, data.length - offset);
      this.buffer.set(data.subarray(offset, offset + take), this.bufferLength);
      this.bufferLength += take;
      offset += take;
      if (this.bufferLength === 64) {
        this.processChunk(this.buffer);
        this.bufferLength = 0;
      }
    }
  }

  digestBytes() {
    if (this.finished) {
      return this.serializeState();
    }
    this.finished = true;
    const buffer = this.buffer;
    let length = this.bufferLength;
    buffer[length++] = 0x80;
    if (length > 56) {
      buffer.fill(0, length, 64);
      this.processChunk(buffer);
      length = 0;
    }
    buffer.fill(0, length, 56);
    const bitsLow = (this.bytesLow << 3) >>> 0;
    const bitsHigh = ((this.bytesHigh << 3) | (this.bytesLow >>> 29)) >>> 0;
    buffer[56] = (bitsHigh >>> 24) & 0xff;
    buffer[57] = (bitsHigh >>> 16) & 0xff;
    buffer[58] = (bitsHigh >>> 8) & 0xff;
    buffer[59] = bitsHigh & 0xff;
    buffer[60] = (bitsLow >>> 24) & 0xff;
    buffer[61] = (bitsLow >>> 16) & 0xff;
    buffer[62] = (bitsLow >>> 8) & 0xff;
    buffer[63] = bitsLow & 0xff;
    this.processChunk(buffer);
    return this.serializeState();
  }

  serializeState() {
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i += 1) {
      const word = this.state[i];
      const base = i * 4;
      out[base] = (word >>> 24) & 0xff;
      out[base + 1] = (word >>> 16) & 0xff;
      out[base + 2] = (word >>> 8) & 0xff;
      out[base + 3] = word & 0xff;
    }
    return out;
  }

  addBytes(length) {
    const low = (this.bytesLow + length) >>> 0;
    if (low < this.bytesLow) {
      this.bytesHigh = (this.bytesHigh + 1) >>> 0;
    }
    this.bytesLow = low;
    this.bytesHigh = (this.bytesHigh + Math.floor(length / 0x100000000)) >>> 0;
  }

  processChunk(chunk) {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i += 1) {
      const base = i * 4;
      w[i] =
        (chunk[base] << 24) |
        (chunk[base + 1] << 16) |
        (chunk[base + 2] << 8) |
        chunk[base + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(value, shift) {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
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

function buildIndex(unpaddedSize, uncompressedSize) {
  const record = concatBytes([encodeVli(unpaddedSize), encodeVli(uncompressedSize)]);
  const indexBody = concatBytes([new Uint8Array([0x00]), encodeVli(1n), record]);
  const padding = (4 - (indexBody.length % 4)) & 3;
  const indexPadded = concatBytes([indexBody, new Uint8Array(padding)]);
  const crc = crc32(indexPadded);
  const crcBytes = new Uint8Array(4);
  writeUint32LE(crcBytes, 0, crc);
  return concatBytes([indexPadded, crcBytes]);
}

function buildStream({ payload, encodedPayload, filters, checkType }) {
  const headerFlags = new Uint8Array([0x00, checkType & 0x0f]);
  const headerCrc = crc32(headerFlags);
  const headerCrcBytes = new Uint8Array(4);
  writeUint32LE(headerCrcBytes, 0, headerCrc);
  const streamHeader = concatBytes([HEADER_MAGIC, headerFlags, headerCrcBytes]);

  const lzma2Data = encodeLzma2Uncompressed(encodedPayload ?? payload);
  const blockHdr = blockHeader(filters);
  const padLen = (4 - (lzma2Data.length % 4)) & 3;
  const blockPad = new Uint8Array(padLen);
  const check = buildCheck(checkType, payload);
  const block = concatBytes([blockHdr, lzma2Data, blockPad, check]);

  const unpaddedSize = BigInt(blockHdr.length + lzma2Data.length + check.length);
  const uncompressedSize = BigInt(payload.length);
  const index = buildIndex(unpaddedSize, uncompressedSize);

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

  return concatBytes([streamHeader, block, index, footer]);
}

function buildCheck(checkType, payload) {
  if (checkType === CHECK_CRC32) {
    const value = crc32(payload);
    const out = new Uint8Array(4);
    writeUint32LE(out, 0, value);
    return out;
  }
  if (checkType === CHECK_SHA256) {
    const sha = new Sha256();
    sha.update(payload);
    return sha.digestBytes();
  }
  throw new Error(`unsupported check type ${checkType}`);
}

function powerpcCode(buffer, nowPos, isEncoder) {
  const size = buffer.length & ~3;
  for (let i = 0; i < size; i += 4) {
    if ((buffer[i] >> 2) !== 0x12) continue;
    if ((buffer[i + 3] & 0x03) !== 0x01) continue;
    const src =
      (((buffer[i] & 0x03) << 24) |
        (buffer[i + 1] << 16) |
        (buffer[i + 2] << 8) |
        (buffer[i + 3] & 0xfc)) >>>
      0;
    const dest = isEncoder
      ? (nowPos + i + src) >>> 0
      : (src - (nowPos + i)) >>> 0;
    buffer[i] = 0x48 | ((dest >>> 24) & 0x03);
    buffer[i + 1] = (dest >>> 16) & 0xff;
    buffer[i + 2] = (dest >>> 8) & 0xff;
    buffer[i + 3] = (buffer[i + 3] & 0x03) | (dest & 0xfc);
  }
}

function armthumbCode(buffer, nowPos, isEncoder) {
  if (buffer.length < 4) return;
  const limit = buffer.length - 4;
  for (let i = 0; i <= limit; i += 2) {
    if ((buffer[i + 1] & 0xf8) === 0xf0 && (buffer[i + 3] & 0xf8) === 0xf8) {
      let src =
        (((buffer[i + 1] & 0x07) << 19) |
          (buffer[i] << 11) |
          ((buffer[i + 3] & 0x07) << 8) |
          buffer[i + 2]) >>>
        0;
      src = (src << 1) >>> 0;
      let dest = isEncoder
        ? (nowPos + i + 4 + src) >>> 0
        : (src - (nowPos + i + 4)) >>> 0;
      dest >>>= 1;
      buffer[i + 1] = 0xf0 | ((dest >>> 19) & 0x07);
      buffer[i] = (dest >>> 11) & 0xff;
      buffer[i + 3] = 0xf8 | ((dest >>> 8) & 0x07);
      buffer[i + 2] = dest & 0xff;
      i += 2;
    }
  }
}

function sparcCode(buffer, nowPos, isEncoder) {
  const size = buffer.length & ~3;
  for (let i = 0; i < size; i += 4) {
    const b0 = buffer[i];
    const b1 = buffer[i + 1];
    if ((b0 === 0x40 && (b1 & 0xc0) === 0x00) || (b0 === 0x7f && (b1 & 0xc0) === 0xc0)) {
      let src = ((b0 << 24) | (b1 << 16) | (buffer[i + 2] << 8) | buffer[i + 3]) >>> 0;
      src = (src << 2) >>> 0;
      let dest = isEncoder
        ? (nowPos + i + src) >>> 0
        : (src - (nowPos + i)) >>> 0;
      dest = (dest >>> 2) >>> 0;
      dest =
        (((0 - ((dest >>> 22) & 1)) << 22) & 0x3fffffff) | (dest & 0x3fffff) | 0x40000000;
      buffer[i] = (dest >>> 24) & 0xff;
      buffer[i + 1] = (dest >>> 16) & 0xff;
      buffer[i + 2] = (dest >>> 8) & 0xff;
      buffer[i + 3] = dest & 0xff;
    }
  }
}

const IA64_BRANCH_TABLE = [
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  4, 4, 6, 6, 0, 0, 7, 7,
  4, 4, 0, 0, 4, 4, 0, 0
];

function ia64Code(buffer, nowPos, isEncoder) {
  const size = buffer.length & ~15;
  for (let i = 0; i < size; i += 16) {
    const template = buffer[i] & 0x1f;
    const mask = IA64_BRANCH_TABLE[template] ?? 0;
    let bitPos = 5;
    for (let slot = 0; slot < 3; slot += 1, bitPos += 41) {
      if (((mask >> slot) & 1) === 0) continue;
      const bytePos = bitPos >> 3;
      const bitRes = bitPos & 0x7;
      let instruction = 0n;
      for (let j = 0; j < 6; j += 1) {
        instruction |= BigInt(buffer[i + j + bytePos]) << BigInt(8 * j);
      }
      let instNorm = instruction >> BigInt(bitRes);
      if (((instNorm >> 37n) & 0xfn) === 0x5n && ((instNorm >> 9n) & 0x7n) === 0n) {
        let src = Number((instNorm >> 13n) & 0xfffffn);
        src |= Number((instNorm >> 36n) & 0x1n) << 20;
        src = (src << 4) >>> 0;
        let dest = isEncoder
          ? (nowPos + i + src) >>> 0
          : (src - (nowPos + i)) >>> 0;
        dest >>>= 4;
        instNorm &= ~(0x8fffffn << 13n);
        instNorm |= BigInt(dest & 0xfffff) << 13n;
        instNorm |= BigInt(dest & 0x100000) << 16n;
        const lowMask = (1n << BigInt(bitRes)) - 1n;
        instruction &= lowMask;
        instruction |= instNorm << BigInt(bitRes);
        for (let j = 0; j < 6; j += 1) {
          buffer[i + j + bytePos] = Number((instruction >> BigInt(8 * j)) & 0xffn);
        }
      }
    }
  }
}

function encodeBcj(filterId, payload, startOffset) {
  const encoderFn = BCJ_ENCODERS.get(filterId);
  if (!encoderFn) return payload;
  const out = new Uint8Array(payload);
  encoderFn(out, startOffset, true);
  return out;
}

async function main() {
  await mkdir(bcjRoot, { recursive: true });
  await mkdir(expectedRoot, { recursive: true });
  for (const fixture of FIXTURES) {
    const startOffset = 0;
    const encodedPayload =
      fixture.bcjId !== undefined ? encodeBcj(fixture.bcjId, fixture.payload, startOffset) : fixture.payload;
    const stream = buildStream({
      payload: fixture.payload,
      encodedPayload,
      filters: fixture.filters,
      checkType: fixture.checkType
    });
    const target = resolve(fixturesRoot, fixture.path);
    await writeFile(target, stream);
    await writeFile(resolve(expectedRoot, fixture.expected), fixture.payload);
  }
}

await main();
