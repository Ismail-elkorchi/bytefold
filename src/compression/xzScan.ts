import { throwIfAborted } from '../abort.js';
import { readUint32LE } from '../binary.js';
import { Crc32 } from '../crc32.js';
import { CompressionError } from '../compress/errors.js';
import { DEFAULT_RESOURCE_LIMITS } from '../limits.js';

const HEADER_MAGIC = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const FOOTER_MAGIC = new Uint8Array([0x59, 0x5a]);
const LZMA2_FILTER_ID = 0x21n;
const MAX_VLI = (1n << 63n) - 1n;

export type XzScanResult = {
  maxDictionaryBytes: number;
  streams: number;
  blocks: number;
  hadPadding: boolean;
  requiredIndexRecords: number;
  requiredIndexBytes: number;
};

export type XzScanOptions = {
  signal?: AbortSignal;
  maxIndexRecords?: number;
  maxIndexBytes?: number;
};

export function scanXzResourceRequirements(data: Uint8Array, options: XzScanOptions = {}): XzScanResult | null {
  try {
    if (data.length < 12) return null;
    const maxIndexRecords = resolveIndexRecordLimit(options.maxIndexRecords);
    const maxIndexBytes = resolveIndexByteLimit(options.maxIndexBytes);

    let end = data.length;
    let streams = 0;
    let blocks = 0;
    let maxDictionaryBytes = 0;
    let hadPadding = false;
    let totalIndexRecords = 0;
    let totalIndexBytes = 0;

    while (end > 0) {
      if (options.signal) throwIfAborted(options.signal);
      let trimmed = 0;
      while (
        end >= 4 &&
        data[end - 1] === 0x00 &&
        data[end - 2] === 0x00 &&
        data[end - 3] === 0x00 &&
        data[end - 4] === 0x00
      ) {
        end -= 4;
        trimmed += 4;
      }
      if (trimmed > 0) hadPadding = true;
      if (end === 0) break;
      if (end < 12) return null;

      const footerOffset = end - 12;
      const footer = data.subarray(footerOffset, end);
      if (!matchesMagic(footer.subarray(10, 12), FOOTER_MAGIC)) return null;

      const storedCrc = readUint32LE(footer, 0);
      const backwardSize = readUint32LE(footer, 4);
      const flags = footer.subarray(8, 10);
      const footerCrc = new Crc32();
      footerCrc.update(footer.subarray(4, 10));
      if (footerCrc.digest() !== storedCrc) return null;

      const indexSize = (backwardSize + 1) * 4;
      const nextIndexBytes = totalIndexBytes + indexSize;
      if (nextIndexBytes > maxIndexBytes) {
        return {
          maxDictionaryBytes,
          streams,
          blocks,
          hadPadding,
          requiredIndexRecords: totalIndexRecords,
          requiredIndexBytes: nextIndexBytes
        };
      }
      totalIndexBytes = nextIndexBytes;

      const indexStart = footerOffset - indexSize;
      if (indexStart < 0) return null;
      const index = data.subarray(indexStart, footerOffset);
      if (index.length < 8) return null;

      if (index[0] !== 0x00) return null;
      const recordCountRes = readVli(index, 1, index.length - 4);
      const recordOffset = recordCountRes.offset;
      const recordCount = toNumberOrThrow(recordCountRes.value, 'XZ index record count');
      const nextIndexRecords = totalIndexRecords + recordCount;
      if (nextIndexRecords > maxIndexRecords) {
        return {
          maxDictionaryBytes,
          streams,
          blocks,
          hadPadding,
          requiredIndexRecords: nextIndexRecords,
          requiredIndexBytes: totalIndexBytes
        };
      }
      totalIndexRecords = nextIndexRecords;

      const crcStored = readUint32LE(index, index.length - 4);
      const crc = new Crc32();
      crc.update(index.subarray(0, index.length - 4));
      if (crc.digest() !== crcStored) return null;

      const pass1 = parseIndexRecords(index, recordOffset, recordCount, undefined, options.signal);
      if (!pass1) return null;
      let offset = pass1.offset;
      const padding = (4 - (offset % 4)) & 3;
      for (let i = 0; i < padding; i += 1) {
        if (offset + i >= index.length - 4) return null;
        if (index[offset + i] !== 0x00) return null;
      }
      if (offset + padding !== index.length - 4) return null;

      const blocksSize = pass1.blocksSize;
      if (blocksSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      const blocksSizeNumber = Number(blocksSize);
      const streamStart = indexStart - blocksSizeNumber - 12;
      if (streamStart < 0) return null;

      const header = data.subarray(streamStart, streamStart + 12);
      if (!matchesMagic(header.subarray(0, 6), HEADER_MAGIC)) return null;
      if (!matchesMagic(header.subarray(6, 8), flags)) return null;
      const headerCrc = readUint32LE(header, 8);
      const headerCrcCalc = new Crc32();
      headerCrcCalc.update(header.subarray(6, 8));
      if (headerCrcCalc.digest() !== headerCrc) return null;

      const expectedIndexStart = streamStart + 12 + blocksSizeNumber;
      if (expectedIndexStart !== indexStart) return null;

      let blockOffset = streamStart + 12;
      const pass2 = parseIndexRecords(index, recordOffset, recordCount, (unpadded) => {
        const dict = readBlockDictionarySize(data, blockOffset);
        if (dict === null) return false;
        if (dict > maxDictionaryBytes) maxDictionaryBytes = dict;
        blocks += 1;
        const blockSize = unpadded + pad4(unpadded);
        if (blockSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        blockOffset += Number(blockSize);
        return true;
      }, options.signal);
      if (!pass2) return null;

      streams += 1;
      end = streamStart;
    }

    if (streams === 0) return null;
    return {
      maxDictionaryBytes,
      streams,
      blocks,
      hadPadding,
      requiredIndexRecords: totalIndexRecords,
      requiredIndexBytes: totalIndexBytes
    };
  } catch (err) {
    if (err instanceof CompressionError) {
      throw err;
    }
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') {
      throw err;
    }
    return null;
  }
}

function resolveIndexRecordLimit(value?: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_RESOURCE_LIMITS.maxXzIndexRecords;
}

function resolveIndexByteLimit(value?: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_RESOURCE_LIMITS.maxXzIndexBytes;
}

function parseIndexRecords(
  index: Uint8Array,
  start: number,
  recordCount: number,
  onRecord?: (unpadded: bigint) => boolean,
  signal?: AbortSignal
): { offset: number; blocksSize: bigint } | null {
  let offset = start;
  let blocksSize = 0n;
  for (let i = 0; i < recordCount; i += 1) {
    if (signal && (i & 0x3ff) === 0) throwIfAborted(signal);
    const unpadded = readVli(index, offset, index.length - 4);
    offset = unpadded.offset;
    const _uncompressed = readVli(index, offset, index.length - 4);
    offset = _uncompressed.offset;
    blocksSize += unpadded.value + pad4(unpadded.value);
    if (onRecord) {
      if (!onRecord(unpadded.value)) return null;
    }
  }
  return { offset, blocksSize };
}

function readBlockDictionarySize(data: Uint8Array, blockOffset: number): number | null {
  if (blockOffset >= data.length) return null;
  const headerSizeByte = data[blockOffset]!;
  if (headerSizeByte === 0x00) return null;
  const headerSize = (headerSizeByte + 1) * 4;
  if (headerSize < 8 || headerSize > 1024) return null;
  const headerEnd = blockOffset + headerSize;
  if (headerEnd > data.length) return null;
  const header = data.subarray(blockOffset, headerEnd);
  const storedCrc = readUint32LE(header, header.length - 4);
  const crc = new Crc32();
  crc.update(header.subarray(0, header.length - 4));
  if (crc.digest() !== storedCrc) return null;

  let offset = 1;
  const flags = header[offset++]!;
  if ((flags & 0x3c) !== 0) return null;
  const filterCount = (flags & 0x03) + 1;
  if (filterCount > 4) return null;
  const hasCompressedSize = (flags & 0x40) !== 0;
  const hasUncompressedSize = (flags & 0x80) !== 0;
  if (hasCompressedSize) {
    const read = readVli(header, offset, header.length - 4);
    offset = read.offset;
  }
  if (hasUncompressedSize) {
    const read = readVli(header, offset, header.length - 4);
    offset = read.offset;
  }

  let dictProp: number | null = null;
  let lastFilter: bigint | null = null;
  for (let i = 0; i < filterCount; i += 1) {
    const id = readVli(header, offset, header.length - 4);
    offset = id.offset;
    const propsSize = readVli(header, offset, header.length - 4);
    offset = propsSize.offset;
    const propsBytes = toNumberOrThrow(propsSize.value, 'XZ filter property size');
    if (offset + propsBytes > header.length - 4) return null;
    if (id.value === LZMA2_FILTER_ID) {
      if (propsBytes !== 1) return null;
      dictProp = header[offset]!;
    }
    offset += propsBytes;
    lastFilter = id.value;
  }

  for (let i = offset; i < header.length - 4; i += 1) {
    if (header[i] !== 0x00) return null;
  }

  if (lastFilter !== LZMA2_FILTER_ID || dictProp === null) return null;
  const dictSize = decodeDictionarySize(dictProp);
  if (dictSize === null) return null;
  return dictSize;
}

function decodeDictionarySize(props: number): number | null {
  const bits = props & 0x3f;
  if (bits > 40) return null;
  if (bits === 40) return 0xffffffff;
  const base = 2 | (bits & 1);
  const shift = (bits >> 1) + 11;
  return base * 2 ** shift;
}

function readVli(buffer: Uint8Array, start: number, end: number): { value: bigint; offset: number } {
  let offset = start;
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < 9; i += 1) {
    if (offset >= end) {
      throw xzBadData('XZ index truncated');
    }
    const byte = buffer[offset++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > MAX_VLI) throw xzBadData('XZ VLI exceeds 63 bits');
      return { value, offset };
    }
    shift += 7n;
  }
  throw xzBadData('XZ VLI is too long');
}

function pad4(value: bigint): bigint {
  return (4n - (value % 4n)) & 3n;
}

function toNumberOrThrow(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw xzBadData(`${label} exceeds safe integer range`);
  }
  return Number(value);
}

function matchesMagic(value: Uint8Array, expected: Uint8Array): boolean {
  if (value.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (value[i] !== expected[i]) return false;
  }
  return true;
}

function xzBadData(message: string): CompressionError {
  return new CompressionError('COMPRESSION_XZ_BAD_DATA', message, { algorithm: 'xz' });
}
