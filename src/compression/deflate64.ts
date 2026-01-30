import { ZipError } from '../errors.js';
import { throwIfAborted } from '../abort.js';
import type { ZipDecompressionOptions } from './types.js';

type HuffmanTable = {
  table: Int32Array;
  maxBits: number;
};

const WINDOW_SIZE = 65536;
const MAX_BITS = 15;
const OUTPUT_CHUNK_SIZE = 32 * 1024;

const CODE_LENGTH_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15
];

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163,
  195, 227
];

const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5
];

const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577, 32769, 49153
];

const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
  14, 14
];

const FIXED_LIT_LENGTHS = (() => {
  const lengths = new Array<number>(288).fill(0);
  for (let i = 0; i <= 143; i += 1) lengths[i] = 8;
  for (let i = 144; i <= 255; i += 1) lengths[i] = 9;
  for (let i = 256; i <= 279; i += 1) lengths[i] = 7;
  for (let i = 280; i <= 287; i += 1) lengths[i] = 8;
  return lengths;
})();

const FIXED_DIST_LENGTHS = new Array<number>(32).fill(5);

const FIXED_LIT_TABLE = buildHuffmanTable(FIXED_LIT_LENGTHS);
const FIXED_DIST_TABLE = buildHuffmanTable(FIXED_DIST_LENGTHS);

export function createDeflate64DecompressStream(options?: ZipDecompressionOptions): TransformStream<Uint8Array, Uint8Array> {
  const inflater = new Deflate64Inflater(options?.signal);
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      inflater.push(chunk, controller);
    },
    flush(controller) {
      inflater.finish(controller);
    }
  });
}

class Deflate64Inflater {
  private readonly reader = new BitReader();
  private readonly window = new Uint8Array(WINDOW_SIZE);
  private windowPos = 0;
  private output = new Uint8Array(OUTPUT_CHUNK_SIZE);
  private outputLen = 0;
  private outputBytes = 0n;

  private state: 'BLOCK_HEADER' | 'STORED_HEADER' | 'STORED_DATA' | 'DYNAMIC' | 'COMPRESSED' | 'DONE' = 'BLOCK_HEADER';
  private isFinalBlock = false;
  private storedRemaining = 0;

  private litTable: HuffmanTable | null = null;
  private distTable: HuffmanTable | null = null;
  private dyn: DynamicState | null = null;

  private pendingStage: 'lengthExtra' | 'distanceSymbol' | 'distanceExtra' | 'copy' | null = null;
  private pendingLengthBase = 0;
  private pendingLengthExtra = 0;
  private pendingLength = 0;
  private pendingDistanceBase = 0;
  private pendingDistanceExtra = 0;
  private pendingDistance = 0;

  constructor(private readonly signal?: AbortSignal) {}

  push(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (chunk.length > 0) {
      this.reader.push(chunk);
    }
    this.process(controller);
  }

  finish(controller: TransformStreamDefaultController<Uint8Array>): void {
    this.reader.finish();
    this.process(controller, true);
    if (this.state !== 'DONE') {
      throw new ZipError('ZIP_TRUNCATED', 'Deflate64 stream truncated');
    }
    this.flushOutput(controller);
  }

  private process(controller: TransformStreamDefaultController<Uint8Array>, flushing = false): void {
    while (true) {
      throwIfAborted(this.signal);
      switch (this.state) {
        case 'BLOCK_HEADER': {
          if (!this.reader.ensureBits(3)) {
            this.flushOutput(controller);
            return;
          }
          const finalBit = this.reader.readBits(1);
          const blockType = this.reader.readBits(2);
          if (finalBit === null || blockType === null) {
            this.flushOutput(controller);
            return;
          }
          this.isFinalBlock = finalBit === 1;
          if (blockType === 0) {
            this.reader.alignToByte();
            this.state = 'STORED_HEADER';
          } else if (blockType === 1) {
            this.litTable = FIXED_LIT_TABLE;
            this.distTable = FIXED_DIST_TABLE;
            this.pendingStage = null;
            this.state = 'COMPRESSED';
          } else if (blockType === 2) {
            this.dyn = null;
            this.state = 'DYNAMIC';
          } else {
            throw new ZipError('ZIP_DEFLATE64_BAD_DATA', 'Invalid Deflate64 block type');
          }
          break;
        }
        case 'STORED_HEADER': {
          if (!this.reader.ensureBits(32)) {
            this.flushOutput(controller);
            return;
          }
          const len = this.reader.readBits(16);
          const nlen = this.reader.readBits(16);
          if (len === null || nlen === null) {
            this.flushOutput(controller);
            return;
          }
          if (((len ^ 0xffff) & 0xffff) !== nlen) {
            throw new ZipError('ZIP_DEFLATE64_BAD_DATA', 'Stored block length mismatch');
          }
          this.storedRemaining = len;
          this.state = 'STORED_DATA';
          break;
        }
        case 'STORED_DATA': {
          while (this.storedRemaining > 0) {
            if (!this.reader.ensureBits(8)) {
              this.flushOutput(controller);
              return;
            }
            const byte = this.reader.readBits(8);
            if (byte === null) {
              this.flushOutput(controller);
              return;
            }
            this.emitByte(byte, controller);
            this.storedRemaining -= 1;
          }
          this.state = this.isFinalBlock ? 'DONE' : 'BLOCK_HEADER';
          break;
        }
        case 'DYNAMIC': {
          if (!this.parseDynamic()) {
            this.flushOutput(controller);
            return;
          }
          this.pendingStage = null;
          this.state = 'COMPRESSED';
          break;
        }
        case 'COMPRESSED': {
          if (!this.decodeCompressed(controller)) {
            this.flushOutput(controller);
            return;
          }
          break;
        }
        case 'DONE': {
          if (flushing) {
            this.flushOutput(controller);
            return;
          }
          this.flushOutput(controller);
          return;
        }
        default:
          this.flushOutput(controller);
          return;
      }
    }
  }

  private parseDynamic(): boolean {
    if (!this.dyn) {
      this.dyn = {
        stage: 'HLIT',
        hlit: 0,
        hdist: 0,
        hclen: 0,
        codeLengths: new Array<number>(19).fill(0),
        codeIndex: 0,
        lengths: [],
        prevLength: 0,
        table: null
      };
    }
    const dyn = this.dyn;
    while (true) {
      switch (dyn.stage) {
        case 'HLIT': {
          const val = this.reader.readBits(5);
          if (val === null) return false;
          dyn.hlit = val + 257;
          dyn.stage = 'HDIST';
          break;
        }
        case 'HDIST': {
          const val = this.reader.readBits(5);
          if (val === null) return false;
          dyn.hdist = val + 1;
          dyn.stage = 'HCLEN';
          break;
        }
        case 'HCLEN': {
          const val = this.reader.readBits(4);
          if (val === null) return false;
          dyn.hclen = val + 4;
          dyn.stage = 'CLEN';
          break;
        }
        case 'CLEN': {
          while (dyn.codeIndex < dyn.hclen) {
            const len = this.reader.readBits(3);
            if (len === null) return false;
            const idx = CODE_LENGTH_ORDER[dyn.codeIndex]!;
            dyn.codeLengths[idx] = len;
            dyn.codeIndex += 1;
          }
          dyn.table = buildHuffmanTable(dyn.codeLengths);
          dyn.stage = 'LENS';
          break;
        }
        case 'LENS': {
          if (!dyn.table) {
            throw new ZipError('ZIP_DEFLATE64_BAD_DATA', 'Missing code-length Huffman table');
          }
          const total = dyn.hlit + dyn.hdist;
          while (dyn.lengths.length < total) {
            const sym = this.decodeSymbol(dyn.table);
            if (sym === null) return false;
            if (sym <= 15) {
              dyn.lengths.push(sym);
              dyn.prevLength = sym;
              continue;
            }
            if (sym === 16) {
              const repeatBits = this.reader.readBits(2);
              if (repeatBits === null) return false;
              const repeat = 3 + repeatBits;
              if (dyn.lengths.length === 0) {
                throw new ZipError('ZIP_DEFLATE64_BAD_DATA', 'Invalid repeat in Huffman lengths');
              }
              for (let i = 0; i < repeat; i += 1) {
                dyn.lengths.push(dyn.prevLength);
              }
              continue;
            }
            if (sym === 17) {
              const repeatBits = this.reader.readBits(3);
              if (repeatBits === null) return false;
              const repeat = 3 + repeatBits;
              for (let i = 0; i < repeat; i += 1) {
                dyn.lengths.push(0);
              }
              dyn.prevLength = 0;
              continue;
            }
            if (sym === 18) {
              const repeatBits = this.reader.readBits(7);
              if (repeatBits === null) return false;
              const repeat = 11 + repeatBits;
              for (let i = 0; i < repeat; i += 1) {
                dyn.lengths.push(0);
              }
              dyn.prevLength = 0;
              continue;
            }
            throw new ZipError('ZIP_DEFLATE64_BAD_DATA', 'Invalid Huffman length symbol');
          }

          const litLengths = dyn.lengths.slice(0, dyn.hlit);
          const distLengths = dyn.lengths.slice(dyn.hlit);
          this.litTable = buildHuffmanTable(litLengths);
          this.distTable = buildHuffmanTable(distLengths);
          this.dyn = null;
          return true;
        }
        default:
          return true;
      }
    }
  }

  private decodeCompressed(controller: TransformStreamDefaultController<Uint8Array>): boolean {
    if (!this.litTable || !this.distTable) {
      throw new ZipError('ZIP_DEFLATE64_BAD_DATA', 'Missing Huffman tables');
    }
    while (true) {
      if (this.pendingStage === 'lengthExtra') {
        if (!this.reader.ensureBits(this.pendingLengthExtra)) return false;
        const extra = this.reader.readBits(this.pendingLengthExtra);
        if (extra === null) return false;
        this.pendingLength = this.pendingLengthBase + extra;
        this.pendingStage = 'distanceSymbol';
      }

      if (this.pendingStage === 'distanceSymbol') {
        const sym = this.decodeSymbol(this.distTable);
        if (sym === null) return false;
        const distInfo = decodeDistance(sym);
        this.pendingDistanceBase = distInfo.base;
        this.pendingDistanceExtra = distInfo.extraBits;
        if (distInfo.extraBits === 0) {
          this.pendingDistance = distInfo.base;
          this.pendingStage = 'copy';
        } else {
          this.pendingStage = 'distanceExtra';
        }
      }

      if (this.pendingStage === 'distanceExtra') {
        if (!this.reader.ensureBits(this.pendingDistanceExtra)) return false;
        const extra = this.reader.readBits(this.pendingDistanceExtra);
        if (extra === null) return false;
        this.pendingDistance = this.pendingDistanceBase + extra;
        this.pendingStage = 'copy';
      }

      if (this.pendingStage === 'copy') {
        this.copyFromDistance(this.pendingLength, this.pendingDistance, controller);
        this.pendingStage = null;
        continue;
      }

      const symbol = this.decodeSymbol(this.litTable);
      if (symbol === null) return false;
      if (symbol < 256) {
        this.emitByte(symbol, controller);
        continue;
      }
      if (symbol === 256) {
        this.state = this.isFinalBlock ? 'DONE' : 'BLOCK_HEADER';
        return true;
      }

      const lenInfo = decodeLength(symbol);
      if (lenInfo.extraBits === 0) {
        this.pendingLength = lenInfo.base;
        this.pendingStage = 'distanceSymbol';
      } else {
        this.pendingLengthBase = lenInfo.base;
        this.pendingLengthExtra = lenInfo.extraBits;
        this.pendingStage = 'lengthExtra';
      }
    }
  }

  private decodeSymbol(table: HuffmanTable): number | null {
    if (!this.reader.ensureBits(table.maxBits)) {
      return null;
    }
    const bits = this.reader.peekBits(table.maxBits);
    if (bits === null) return null;
    const entry = table.table[bits] ?? 0;
    const len = entry >>> 16;
    if (len === 0) {
      throw new ZipError('ZIP_DEFLATE64_BAD_DATA', 'Invalid Huffman code');
    }
    this.reader.dropBits(len);
    return entry & 0xffff;
  }

  private emitByte(byte: number, controller: TransformStreamDefaultController<Uint8Array>): void {
    this.window[this.windowPos] = byte;
    this.windowPos = (this.windowPos + 1) & (WINDOW_SIZE - 1);
    this.output[this.outputLen] = byte;
    this.outputLen += 1;
    this.outputBytes += 1n;
    if (this.outputLen >= OUTPUT_CHUNK_SIZE) {
      this.flushOutput(controller);
    }
  }

  private flushOutput(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.outputLen === 0) return;
    controller.enqueue(this.output.subarray(0, this.outputLen));
    this.outputLen = 0;
  }

  private copyFromDistance(length: number, distance: number, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (distance <= 0 || distance > WINDOW_SIZE) {
      throw new ZipError('ZIP_DEFLATE64_BAD_DATA', 'Invalid distance');
    }
    if (this.outputBytes < BigInt(distance)) {
      throw new ZipError('ZIP_DEFLATE64_BAD_DATA', 'Distance exceeds output window');
    }
    for (let i = 0; i < length; i += 1) {
      const srcIndex = (this.windowPos - distance + WINDOW_SIZE) & (WINDOW_SIZE - 1);
      const byte = this.window[srcIndex]!;
      this.emitByte(byte, controller);
    }
  }
}

type DynamicState = {
  stage: 'HLIT' | 'HDIST' | 'HCLEN' | 'CLEN' | 'LENS';
  hlit: number;
  hdist: number;
  hclen: number;
  codeLengths: number[];
  codeIndex: number;
  lengths: number[];
  prevLength: number;
  table: HuffmanTable | null;
};

class BitReader {
  private chunks: Uint8Array[] = [];
  private chunkIndex = 0;
  private chunkOffset = 0;
  private bitBuffer = 0;
  private bitCount = 0;
  private finished = false;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
  }

  finish(): void {
    this.finished = true;
  }

  ensureBits(count: number): boolean {
    while (this.bitCount < count) {
      const next = this.readByte();
      if (next === null) {
        return false;
      }
      this.bitBuffer |= next << this.bitCount;
      this.bitCount += 8;
    }
    return true;
  }

  readBits(count: number): number | null {
    if (!this.ensureBits(count)) return null;
    const mask = count === 32 ? 0xffffffff : (1 << count) - 1;
    const value = this.bitBuffer & mask;
    this.bitBuffer >>>= count;
    this.bitCount -= count;
    return value;
  }

  peekBits(count: number): number | null {
    if (!this.ensureBits(count)) return null;
    const mask = count === 32 ? 0xffffffff : (1 << count) - 1;
    return this.bitBuffer & mask;
  }

  dropBits(count: number): void {
    this.bitBuffer >>>= count;
    this.bitCount -= count;
  }

  alignToByte(): void {
    const drop = this.bitCount & 7;
    if (drop > 0) {
      this.bitBuffer >>>= drop;
      this.bitCount -= drop;
    }
  }

  private readByte(): number | null {
    while (this.chunkIndex < this.chunks.length) {
      const chunk = this.chunks[this.chunkIndex]!;
      if (this.chunkOffset < chunk.length) {
        const value = chunk[this.chunkOffset]!;
        this.chunkOffset += 1;
        return value;
      }
      this.chunkIndex += 1;
      this.chunkOffset = 0;
    }
    return this.finished ? null : null;
  }
}

function decodeLength(symbol: number): { base: number; extraBits: number } {
  if (symbol >= 257 && symbol <= 284) {
    const idx = symbol - 257;
    return { base: LENGTH_BASE[idx]!, extraBits: LENGTH_EXTRA[idx]! };
  }
  if (symbol === 285) {
    return { base: 3, extraBits: 16 };
  }
  throw new ZipError('ZIP_DEFLATE64_BAD_DATA', 'Invalid length code');
}

function decodeDistance(symbol: number): { base: number; extraBits: number } {
  if (symbol < 0 || symbol >= DIST_BASE.length) {
    throw new ZipError('ZIP_DEFLATE64_BAD_DATA', 'Invalid distance code');
  }
  return { base: DIST_BASE[symbol]!, extraBits: DIST_EXTRA[symbol]! };
}

function buildHuffmanTable(lengths: number[]): HuffmanTable {
  let maxLen = 0;
  const blCount = new Array<number>(MAX_BITS + 1).fill(0);
  for (const len of lengths) {
    if (len === 0) continue;
    if (len > MAX_BITS) {
      throw new ZipError('ZIP_DEFLATE64_BAD_DATA', 'Invalid Huffman code length');
    }
    blCount[len] = (blCount[len] ?? 0) + 1;
    if (len > maxLen) maxLen = len;
  }
  if (maxLen === 0) {
    throw new ZipError('ZIP_DEFLATE64_BAD_DATA', 'Empty Huffman table');
  }
  const nextCode = new Array<number>(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits += 1) {
    code = (code + (blCount[bits - 1] ?? 0)) << 1;
    nextCode[bits] = code;
    if (code + (blCount[bits] ?? 0) > (1 << bits)) {
      throw new ZipError('ZIP_DEFLATE64_BAD_DATA', 'Over-subscribed Huffman table');
    }
  }
  const tableSize = 1 << maxLen;
  const table = new Int32Array(tableSize);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const len = lengths[symbol]!;
    if (len === 0) continue;
    const current = nextCode[len] ?? 0;
    nextCode[len] = current + 1;
    const reversed = reverseBits(current, len);
    const entry = (len << 16) | symbol;
    for (let i = reversed; i < tableSize; i += 1 << len) {
      table[i] = entry;
    }
  }
  return { table, maxBits: maxLen };
}

function reverseBits(value: number, length: number): number {
  let out = 0;
  let input = value;
  for (let i = 0; i < length; i += 1) {
    out = (out << 1) | (input & 1);
    input >>>= 1;
  }
  return out;
}
