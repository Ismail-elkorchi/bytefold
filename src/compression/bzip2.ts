import { throwIfAborted } from '../abort.js';
import { CompressionError } from '../compress/errors.js';

const BLOCK_MAGIC = 0x314159265359n;
const END_MAGIC = 0x177245385090n;
const MAX_CODE_LENGTH = 20;
const GROUP_SIZE = 50;

const RUNA = 0;
const RUNB = 1;
const BZIP2_CRC_POLY = 0x04c11db7;
const BZIP2_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i << 24;
    for (let k = 0; k < 8; k += 1) {
      if ((crc & 0x80000000) !== 0) {
        crc = ((crc << 1) ^ BZIP2_CRC_POLY) >>> 0;
      } else {
        crc = (crc << 1) >>> 0;
      }
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export type Bzip2DecompressOptions = {
  signal?: AbortSignal;
  maxOutputBytes?: bigint | number;
  maxCompressionRatio?: number;
};

export function createBzip2DecompressStream(
  options: Bzip2DecompressOptions = {}
): ReadableWritablePair<Uint8Array, Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalIn = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk) {
      if (options.signal) throwIfAborted(options.signal);
      if (!chunk || chunk.length === 0) return;
      chunks.push(chunk);
      totalIn += chunk.length;
    },
    flush(controller) {
      if (options.signal) throwIfAborted(options.signal);
      const input = concatChunks(chunks);
      const decodeOptions: DecodeOptions = {
        compressedSize: totalIn,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
        ...(options.maxCompressionRatio !== undefined ? { maxCompressionRatio: options.maxCompressionRatio } : {})
      };
      const output = decodeBzip2(input, decodeOptions);
      for (const part of splitChunks(output)) {
        if (options.signal) throwIfAborted(options.signal);
        controller.enqueue(part);
      }
    }
  });
}

type DecodeOptions = {
  signal?: AbortSignal;
  maxOutputBytes?: bigint | number;
  maxCompressionRatio?: number;
  compressedSize: number;
};

function decodeBzip2(input: Uint8Array, options: DecodeOptions): Uint8Array {
  if (input.length < 4) {
    throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Truncated bzip2 header');
  }
  if (input[0] !== 0x42 || input[1] !== 0x5a || input[2] !== 0x68) {
    throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Invalid bzip2 header');
  }
  const level = (input[3] ?? 0) - 0x30;
  if (level < 1 || level > 9) {
    throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Invalid bzip2 block size');
  }
  const maxBlockSize = level * 100000;
  const reader = new BitReader(input, 4);

  let combinedCrc = 0;
  const outputChunks: Uint8Array[] = [];
  let totalOut = 0n;

  const maxOutputBytes = options.maxOutputBytes !== undefined ? toBigInt(options.maxOutputBytes) : undefined;
  const maxRatioBytes =
    options.maxCompressionRatio !== undefined
      ? BigInt(Math.ceil(options.compressedSize * options.maxCompressionRatio))
      : undefined;

  while (true) {
    if (options.signal) throwIfAborted(options.signal);
    const magic = reader.readUint48();
    if (magic === null) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Unexpected end of bzip2 stream');
    }
    if (magic === END_MAGIC) {
      const storedCombined = reader.readUint32();
      if (storedCombined === null) {
        throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Truncated bzip2 trailer');
      }
      if ((storedCombined >>> 0) !== (combinedCrc >>> 0)) {
        throw new CompressionError('COMPRESSION_BZIP2_CRC_MISMATCH', 'BZip2 combined CRC mismatch');
      }
      break;
    }
    if (magic !== BLOCK_MAGIC) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Invalid bzip2 block header');
    }

    const blockCrc = reader.readUint32();
    if (blockCrc === null) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Truncated bzip2 block CRC');
    }

    const randomized = reader.readBits(1);
    if (randomized === null) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Truncated bzip2 block header');
    }
    if (randomized !== 0) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Randomized bzip2 blocks are unsupported');
    }

    const origPtr = reader.readBits(24);
    if (origPtr === null) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Truncated bzip2 block header');
    }

    const inUse = readInUse(reader);
    const symbols: number[] = [];
    for (let i = 0; i < 256; i += 1) {
      if (inUse[i]) symbols.push(i);
    }
    const nInUse = symbols.length;
    if (nInUse === 0) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'No symbols defined in bzip2 block');
    }

    const alphaSize = nInUse + 2;
    const nGroups = reader.readBits(3);
    if (nGroups === null || nGroups < 2 || nGroups > 6) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Invalid bzip2 Huffman group count');
    }

    const nSelectors = reader.readBits(15);
    if (nSelectors === null || nSelectors < 1) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Invalid bzip2 selector count');
    }

    const selectors = readSelectors(reader, nGroups, nSelectors);
    const tables = readHuffmanTables(reader, nGroups, alphaSize);

    const decoded = new Uint8Array(maxBlockSize);
    let decodedLength = 0;

    const mtf: number[] = [...symbols];
    let groupPos = 0;
    let selectorIndex = 0;
    let groupNo = 0;

    const decodeSymbol = () => {
      if (groupPos === 0) {
        groupPos = GROUP_SIZE;
        if (selectorIndex >= selectors.length) {
          throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Selector index out of range');
        }
        groupNo = selectors[selectorIndex++]!;
      }
      groupPos -= 1;
      return decodeHuffman(reader, tables[groupNo]!);
    };

    const eob = nInUse + 1;

    while (true) {
      if (options.signal) throwIfAborted(options.signal);
      let sym = decodeSymbol();
      if (sym === eob) break;

      if (sym === RUNA || sym === RUNB) {
        let run = 0;
        let increment = 1;
        while (sym === RUNA || sym === RUNB) {
          if (sym === RUNA) run += increment;
          else run += increment * 2;
          increment <<= 1;
          sym = decodeSymbol();
        }
        const value = mtf[0]!;
        const runLength = run;
        if (decodedLength + runLength > decoded.length) {
          throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'BZip2 block exceeds maximum size');
        }
        for (let i = 0; i < runLength; i += 1) {
          decoded[decodedLength++] = value;
        }
        if (sym === eob) break;
      }

      if (sym === eob) break;
      const idx = sym - 1;
      if (idx < 0 || idx >= mtf.length) {
        throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'BZip2 MTF index out of range');
      }
      const value = mtf[idx]!;
      if (decodedLength >= decoded.length) {
        throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'BZip2 block exceeds maximum size');
      }
      decoded[decodedLength++] = value;
      mtf.splice(idx, 1);
      mtf.unshift(value);
    }

    if (origPtr >= decodedLength) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Invalid bzip2 block pointer');
    }

    const bwtBlock = decoded.subarray(0, decodedLength);
    const unbwt = inverseBwt(bwtBlock, origPtr);
    const rleDecoded = decodeRle1(unbwt, options.signal);

    const crc = computeCrc(rleDecoded);
    if ((crc >>> 0) !== (blockCrc >>> 0)) {
      throw new CompressionError('COMPRESSION_BZIP2_CRC_MISMATCH', 'BZip2 block CRC mismatch');
    }

    combinedCrc = ((combinedCrc << 1) | (combinedCrc >>> 31)) ^ (crc >>> 0);

    totalOut += BigInt(rleDecoded.length);
    if (maxOutputBytes !== undefined && totalOut > maxOutputBytes) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'BZip2 output exceeds maxOutputBytes');
    }
    if (maxRatioBytes !== undefined && totalOut > maxRatioBytes) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'BZip2 output exceeds maxCompressionRatio');
    }

    outputChunks.push(rleDecoded);
  }

  return concatChunks(outputChunks);
}

class BitReader {
  private offset: number;
  private bitBuffer: bigint = 0n;
  private bitCount = 0;

  constructor(private readonly buffer: Uint8Array, offset = 0) {
    this.offset = offset;
  }

  readBits(count: number): number | null {
    if (count <= 0) return 0;
    while (this.bitCount < count) {
      if (this.offset >= this.buffer.length) return null;
      this.bitBuffer = (this.bitBuffer << 8n) | BigInt(this.buffer[this.offset++]!);
      this.bitCount += 8;
    }
    const shift = BigInt(this.bitCount - count);
    const mask = (1n << BigInt(count)) - 1n;
    const value = Number((this.bitBuffer >> shift) & mask);
    this.bitCount -= count;
    if (this.bitCount === 0) {
      this.bitBuffer = 0n;
    } else {
      this.bitBuffer = this.bitBuffer & ((1n << BigInt(this.bitCount)) - 1n);
    }
    return value;
  }

  readUint32(): number | null {
    const high = this.readBits(16);
    const low = this.readBits(16);
    if (high === null || low === null) return null;
    return ((high << 16) | low) >>> 0;
  }

  readUint48(): bigint | null {
    const high = this.readBits(24);
    const low = this.readBits(24);
    if (high === null || low === null) return null;
    return (BigInt(high) << 24n) | BigInt(low);
  }
}

type HuffmanTable = {
  minLen: number;
  maxLen: number;
  limit: Int32Array;
  base: Int32Array;
  perm: Int32Array;
};

function readInUse(reader: BitReader): boolean[] {
  const inUse = new Array(256).fill(false);
  const inUse16 = new Array(16).fill(false);
  for (let i = 0; i < 16; i += 1) {
    const bit = reader.readBits(1);
    if (bit === null) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Truncated bzip2 in-use map');
    }
    inUse16[i] = bit === 1;
  }
  for (let i = 0; i < 16; i += 1) {
    if (!inUse16[i]) continue;
    for (let j = 0; j < 16; j += 1) {
      const bit = reader.readBits(1);
      if (bit === null) {
        throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Truncated bzip2 in-use map');
      }
      if (bit === 1) inUse[i * 16 + j] = true;
    }
  }
  return inUse;
}

function readSelectors(reader: BitReader, groups: number, selectorCount: number): number[] {
  const selectors: number[] = new Array(selectorCount);
  const mtf: number[] = [];
  for (let i = 0; i < groups; i += 1) mtf.push(i);
  for (let i = 0; i < selectorCount; i += 1) {
    let count = 0;
    while (true) {
      const bit = reader.readBits(1);
      if (bit === null) {
        throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Truncated bzip2 selector');
      }
      if (bit === 0) break;
      count += 1;
    }
    if (count >= mtf.length) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Invalid bzip2 selector');
    }
    const value = mtf.splice(count, 1)[0]!;
    mtf.unshift(value);
    selectors[i] = value;
  }
  return selectors;
}

function readHuffmanTables(reader: BitReader, groups: number, alphaSize: number): HuffmanTable[] {
  const tables: HuffmanTable[] = [];
  for (let g = 0; g < groups; g += 1) {
    let currLen = reader.readBits(5);
    if (currLen === null || currLen < 1 || currLen > MAX_CODE_LENGTH) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Invalid bzip2 code length');
    }
    const lengths = new Array(alphaSize).fill(0);
    for (let i = 0; i < alphaSize; i += 1) {
      while (true) {
        const bit = reader.readBits(1);
        if (bit === null) {
          throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Truncated bzip2 Huffman table');
        }
        if (bit === 0) break;
        const bit2 = reader.readBits(1);
        if (bit2 === null) {
          throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Truncated bzip2 Huffman table');
        }
        currLen += bit2 === 0 ? 1 : -1;
        if (currLen < 1 || currLen > MAX_CODE_LENGTH) {
          throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Invalid bzip2 code length');
        }
      }
      lengths[i] = currLen;
    }
    tables.push(buildHuffmanTable(lengths));
  }
  return tables;
}

function buildHuffmanTable(lengths: number[]): HuffmanTable {
  let minLen = Infinity;
  let maxLen = 0;
  for (const len of lengths) {
    if (len > maxLen) maxLen = len;
    if (len < minLen) minLen = len;
  }
  if (!Number.isFinite(minLen) || maxLen === 0) {
    throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Invalid bzip2 Huffman table');
  }

  const limit = new Int32Array(maxLen + 1);
  const base = new Int32Array(maxLen + 2);
  const perm: number[] = [];

  for (let i = 0; i < lengths.length; i += 1) {
    const len = lengths[i]!;
    base[len + 1] = (base[len + 1] ?? 0) + 1;
  }
  for (let i = 1; i < base.length; i += 1) {
    base[i] = (base[i] ?? 0) + (base[i - 1] ?? 0);
  }

  for (let i = minLen; i <= maxLen; i += 1) {
    for (let j = 0; j < lengths.length; j += 1) {
      if (lengths[j] === i) perm.push(j);
    }
  }

  let vec = 0;
  for (let i = minLen; i <= maxLen; i += 1) {
    vec += base[i + 1]! - base[i]!;
    limit[i] = vec - 1;
    vec <<= 1;
  }
  for (let i = minLen + 1; i <= maxLen; i += 1) {
    base[i] = ((limit[i - 1]! + 1) << 1) - base[i]!;
  }

  return {
    minLen,
    maxLen,
    limit,
    base,
    perm: Int32Array.from(perm)
  };
}

function decodeHuffman(reader: BitReader, table: HuffmanTable): number {
  let codeLength = table.minLen;
  let code = reader.readBits(codeLength);
  if (code === null) {
    throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Truncated bzip2 data');
  }
  while (codeLength <= table.maxLen && code > table.limit[codeLength]!) {
    const bit = reader.readBits(1);
    if (bit === null) {
      throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Truncated bzip2 data');
    }
    code = (code << 1) | bit;
    codeLength += 1;
  }
  if (codeLength > table.maxLen) {
    throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Invalid bzip2 Huffman code');
  }
  return table.perm[code - table.base[codeLength]!]!;
}

function inverseBwt(data: Uint8Array, origPtr: number): Uint8Array {
  const n = data.length;
  const counts = new Int32Array(256);
  for (let i = 0; i < n; i += 1) {
    const value = data[i] ?? 0;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  const cumulative = new Int32Array(257);
  for (let i = 0; i < 256; i += 1) {
    cumulative[i + 1] = cumulative[i]! + counts[i]!;
  }
  const tt = new Int32Array(n);
  const running = cumulative.slice(0, 256);
  for (let i = 0; i < n; i += 1) {
    const value = data[i]!;
    tt[running[value] ?? 0] = i;
    running[value] = (running[value] ?? 0) + 1;
  }
  let t = tt[origPtr]!;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = data[t]!;
    t = tt[t]!;
  }
  return out;
}

function decodeRle1(data: Uint8Array, signal?: AbortSignal): Uint8Array {
  const out: number[] = [];
  let runByte = -1;
  let runCount = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (signal && (i & 0x3fff) === 0) throwIfAborted(signal);
    const value = data[i]!;
    out.push(value);
    if (value === runByte) {
      runCount += 1;
    } else {
      runByte = value;
      runCount = 1;
    }
    if (runCount === 4) {
      if (i + 1 >= data.length) {
        throw new CompressionError('COMPRESSION_BZIP2_BAD_DATA', 'Truncated bzip2 RLE data');
      }
      const extra = data[++i]!;
      for (let j = 0; j < extra; j += 1) {
        out.push(value);
      }
      runCount = 0;
      runByte = -1;
    }
  }
  return Uint8Array.from(out);
}

function computeCrc(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    const idx = ((crc >>> 24) ^ data[i]!) & 0xff;
    crc = ((crc << 8) ^ BZIP2_CRC_TABLE[idx]!) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function splitChunks(data: Uint8Array, chunkSize = 65536): Uint8Array[] {
  if (data.length <= chunkSize) return [data];
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    chunks.push(data.subarray(i, Math.min(i + chunkSize, data.length)));
  }
  return chunks;
}

function toBigInt(value: bigint | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
