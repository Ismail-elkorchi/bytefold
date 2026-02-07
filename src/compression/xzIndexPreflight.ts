import { throwIfAborted } from '../abort.js';
import { readUint32LE } from '../binary.js';
import { Crc32 } from '../crc32.js';
import type { RandomAccess } from '../reader/RandomAccess.js';

const FOOTER_MAGIC = new Uint8Array([0x59, 0x5a]);
const LZMA2_FILTER_ID = 0x21n;
const MAX_VLI = (1n << 63n) - 1n;
const INDEX_PREFIX_BYTES = 32;
const TAIL_SCAN_CHUNK = 32 * 1024;

export type XzIndexPreflightResult = {
  ok: boolean;
  requiredIndexBytes?: number;
  requiredIndexRecords?: number;
  requiredDictionaryBytes?: number;
  streamsScanned: number;
  preflightComplete: boolean;
  preflightBlockHeaders?: number;
  preflightBlockLimit?: number;
};

export type XzIndexPreflightOptions = {
  signal?: AbortSignal;
  maxIndexRecords: number;
  maxIndexBytes: number;
  maxDictionaryBytes: bigint;
  maxPreflightBlockHeaders: number;
};

export async function preflightXzIndexLimits(
  reader: RandomAccess,
  size: bigint,
  options: XzIndexPreflightOptions
): Promise<XzIndexPreflightResult | null> {
  if (size < 12n) return null;
  let end = size;
  let streamsScanned = 0;
  let totalIndexBytes = 0;
  let totalIndexRecords = 0n;
  let maxDictionaryBytes = 0;
  let preflightComplete = true;
  let preflightBlockHeaders: number | undefined;
  let preflightBlockLimit: number | undefined;
  const maxBlockHeaders = normalizePreflightHeaderLimit(options.maxPreflightBlockHeaders);

  while (end > 0n) {
    const streamEnd = await findStreamEnd(reader, end, options.signal);
    if (streamEnd === null) break;
    if (streamEnd < 12n) return null;
    const footerStart = streamEnd - 12n;
    const footer = await reader.read(footerStart, 12, options.signal);
    if (!matchesMagic(footer.subarray(10, 12), FOOTER_MAGIC)) return null;

    const storedCrc = readUint32LE(footer, 0);
    const footerCrc = new Crc32();
    footerCrc.update(footer.subarray(4, 10));
    if (footerCrc.digest() !== storedCrc) return null;

    const backwardSize = readUint32LE(footer, 4);
    const indexSize = (backwardSize + 1) * 4;
    if (indexSize <= 0) return null;

    totalIndexBytes += indexSize;
    if (totalIndexBytes > options.maxIndexBytes) {
      return buildResult({
        ok: false,
        requiredIndexBytes: totalIndexBytes,
        requiredIndexRecords: toSafeNumber(totalIndexRecords),
        requiredDictionaryBytes: maxDictionaryBytes,
        streamsScanned: streamsScanned + 1,
        preflightComplete,
        ...(preflightBlockHeaders !== undefined ? { preflightBlockHeaders } : {}),
        ...(preflightBlockLimit !== undefined ? { preflightBlockLimit } : {})
      });
    }

    const indexStart = footerStart - BigInt(indexSize);
    if (indexStart < 0n) return null;

    const prefixSize = Math.min(indexSize, INDEX_PREFIX_BYTES);
    if (prefixSize < 2) return null;
    const prefix = await reader.read(indexStart, prefixSize, options.signal);
    if (prefix[0] !== 0x00) return null;

    const recordCount = readVli(prefix, 1, prefix.length);
    if (!recordCount) return null;
    if (recordCount.value > MAX_VLI) return null;
    const recordCountNumber =
      recordCount.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(recordCount.value) : Number.MAX_SAFE_INTEGER;
    totalIndexRecords += recordCount.value;
    if (totalIndexRecords > BigInt(options.maxIndexRecords)) {
      return buildResult({
        ok: false,
        requiredIndexBytes: totalIndexBytes,
        requiredIndexRecords: toSafeNumber(totalIndexRecords),
        requiredDictionaryBytes: maxDictionaryBytes,
        streamsScanned: streamsScanned + 1,
        preflightComplete,
        ...(preflightBlockHeaders !== undefined ? { preflightBlockHeaders } : {}),
        ...(preflightBlockLimit !== undefined ? { preflightBlockLimit } : {})
      });
    }

    const index = await reader.read(indexStart, indexSize, options.signal);
    const indexOk = parseIndexForBlocks(index, recordCountNumber, options.signal);
    if (!indexOk) return null;
    const { blocksSize, recordsStart } = indexOk;
    const streamStart = indexStart - blocksSize - 12n;
    if (streamStart < 0n) return null;

    const header = await reader.read(streamStart, 12, options.signal);
    if (!matchesMagic(header.subarray(0, 6), headerMagic)) return null;
    if (!matchesMagic(header.subarray(6, 8), footer.subarray(8, 10))) return null;
    const headerCrc = readUint32LE(header, 8);
    const headerCrcCalc = new Crc32();
    headerCrcCalc.update(header.subarray(6, 8));
    if (headerCrcCalc.digest() !== headerCrc) return null;

    if (recordCountNumber > maxBlockHeaders) {
      preflightComplete = false;
      preflightBlockLimit = maxBlockHeaders;
      if (!preflightBlockHeaders || recordCountNumber > preflightBlockHeaders) {
        preflightBlockHeaders = recordCountNumber;
      }
    }
    const recordsToScan = Math.min(recordCountNumber, maxBlockHeaders);
    if (recordsToScan > 0) {
      let offset = recordsStart;
      let blockOffset = streamStart + 12n;
      for (let i = 0; i < recordCountNumber; i += 1) {
        if (options.signal && (i & 0x3ff) === 0) throwIfAborted(options.signal);
        const unpadded = readVli(index, offset, index.length - 4);
        if (!unpadded) return null;
        offset = unpadded.offset;
        const uncompressed = readVli(index, offset, index.length - 4);
        if (!uncompressed) return null;
        offset = uncompressed.offset;
        if (i < recordsToScan) {
          const dict = await readBlockDictionarySize(reader, blockOffset, options.signal);
          if (dict === null) return null;
          if (dict > maxDictionaryBytes) maxDictionaryBytes = dict;
          if (BigInt(dict) > options.maxDictionaryBytes) {
            return buildResult({
              ok: false,
              requiredIndexBytes: totalIndexBytes,
              requiredIndexRecords: toSafeNumber(totalIndexRecords),
              requiredDictionaryBytes: dict,
              streamsScanned: streamsScanned + 1,
              preflightComplete,
              ...(preflightBlockHeaders !== undefined ? { preflightBlockHeaders } : {}),
              ...(preflightBlockLimit !== undefined ? { preflightBlockLimit } : {})
            });
          }
        } else {
          break;
        }
        blockOffset += unpadded.value + pad4(unpadded.value);
      }
    }

    streamsScanned += 1;
    end = streamStart;
  }

  if (streamsScanned === 0) return null;
  return buildResult({
    ok: true,
    requiredIndexBytes: totalIndexBytes,
    requiredIndexRecords: toSafeNumber(totalIndexRecords),
    requiredDictionaryBytes: maxDictionaryBytes,
    streamsScanned,
    preflightComplete,
    ...(preflightBlockHeaders !== undefined ? { preflightBlockHeaders } : {}),
    ...(preflightBlockLimit !== undefined ? { preflightBlockLimit } : {})
  });
}

const headerMagic = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);

async function findStreamEnd(
  reader: RandomAccess,
  end: bigint,
  signal?: AbortSignal
): Promise<bigint | null> {
  while (end >= 4n) {
    throwIfAborted(signal);
    const chunkSize = Number(minBigInt(BigInt(TAIL_SCAN_CHUNK), end));
    const start = end - BigInt(chunkSize);
    const chunk = await reader.read(start, chunkSize, signal);
    let offset = chunk.length - 4;
    if (offset < 0) return null;
    offset -= offset % 4;
    for (let i = offset; i >= 0; i -= 4) {
      if (chunk[i] !== 0 || chunk[i + 1] !== 0 || chunk[i + 2] !== 0 || chunk[i + 3] !== 0) {
        return start + BigInt(i + 4);
      }
    }
    end = start;
  }
  return null;
}

function readVli(
  buffer: Uint8Array,
  start: number,
  end: number
): { value: bigint; offset: number } | null {
  let offset = start;
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < 9; i += 1) {
    if (offset >= end) return null;
    const byte = buffer[offset++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > MAX_VLI) return null;
      return { value, offset };
    }
    shift += 7n;
  }
  return null;
}

function matchesMagic(value: Uint8Array, expected: Uint8Array): boolean {
  if (value.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (value[i] !== expected[i]) return false;
  }
  return true;
}

function parseIndexForBlocks(
  index: Uint8Array,
  recordCount: number,
  signal?: AbortSignal
): { blocksSize: bigint; recordsStart: number } | null {
  if (index.length < 8) return null;
  if (index[0] !== 0x00) return null;
  const storedCrc = readUint32LE(index, index.length - 4);
  const crc = new Crc32();
  crc.update(index.subarray(0, index.length - 4));
  if (crc.digest() !== storedCrc) return null;
  let offset = 1;
  const recordCountRes = readVli(index, offset, index.length - 4);
  if (!recordCountRes) return null;
  if (recordCountRes.value <= BigInt(Number.MAX_SAFE_INTEGER) && Number(recordCountRes.value) !== recordCount) {
    return null;
  }
  const recordsStart = recordCountRes.offset;
  offset = recordsStart;
  let blocksSize = 0n;
  for (let i = 0; i < recordCount; i += 1) {
    if (signal && (i & 0x3ff) === 0) throwIfAborted(signal);
    const unpadded = readVli(index, offset, index.length - 4);
    if (!unpadded) return null;
    offset = unpadded.offset;
    const uncompressed = readVli(index, offset, index.length - 4);
    if (!uncompressed) return null;
    offset = uncompressed.offset;
    blocksSize += unpadded.value + pad4(unpadded.value);
  }
  const padding = (4 - (offset % 4)) & 3;
  for (let i = 0; i < padding; i += 1) {
    if (offset + i >= index.length - 4) return null;
    if (index[offset + i] !== 0x00) return null;
  }
  if (offset + padding !== index.length - 4) return null;
  return { blocksSize, recordsStart };
}

async function readBlockDictionarySize(
  reader: RandomAccess,
  blockOffset: bigint,
  signal?: AbortSignal
): Promise<number | null> {
  const headerSizeBuf = await reader.read(blockOffset, 1, signal);
  if (headerSizeBuf.length < 1) return null;
  const headerSizeByte = headerSizeBuf[0]!;
  if (headerSizeByte === 0x00) return null;
  const headerSize = (headerSizeByte + 1) * 4;
  if (headerSize < 8 || headerSize > 1024) return null;
  const header = await reader.read(blockOffset, headerSize, signal);
  if (header.length < headerSize) return null;
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
    if (!read) return null;
    offset = read.offset;
  }
  if (hasUncompressedSize) {
    const read = readVli(header, offset, header.length - 4);
    if (!read) return null;
    offset = read.offset;
  }

  let dictProp: number | null = null;
  let lastFilter: bigint | null = null;
  for (let i = 0; i < filterCount; i += 1) {
    const id = readVli(header, offset, header.length - 4);
    if (!id) return null;
    offset = id.offset;
    const propsSize = readVli(header, offset, header.length - 4);
    if (!propsSize) return null;
    offset = propsSize.offset;
    if (propsSize.value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const propsBytes = Number(propsSize.value);
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

function normalizePreflightHeaderLimit(value: number): number {
  if (Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  return 1;
}

function pad4(value: bigint): bigint {
  return (4n - (value % 4n)) & 3n;
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(value);
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function buildResult(params: {
  ok: boolean;
  requiredIndexBytes: number;
  requiredIndexRecords: number;
  requiredDictionaryBytes: number;
  streamsScanned: number;
  preflightComplete: boolean;
  preflightBlockHeaders?: number;
  preflightBlockLimit?: number;
}): XzIndexPreflightResult {
  const result: XzIndexPreflightResult = {
    ok: params.ok,
    requiredIndexBytes: params.requiredIndexBytes,
    requiredIndexRecords: params.requiredIndexRecords,
    requiredDictionaryBytes: params.requiredDictionaryBytes,
    streamsScanned: params.streamsScanned,
    preflightComplete: params.preflightComplete
  };
  if (params.preflightBlockHeaders !== undefined) {
    result.preflightBlockHeaders = params.preflightBlockHeaders;
  }
  if (params.preflightBlockLimit !== undefined) {
    result.preflightBlockLimit = params.preflightBlockLimit;
  }
  return result;
}
