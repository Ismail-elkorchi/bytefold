import { throwIfAborted } from '../abort.js';
import { readUint32LE } from '../binary.js';
import { Crc32 } from '../crc32.js';
import { Crc64 } from '../crc64.js';
import { Sha256 } from '../crypto/sha256.js';
import { CompressionError } from '../compress/errors.js';
import type { CompressionProfile } from '../compress/types.js';
import { emitStable } from '../streams/emit.js';
import { AGENT_RESOURCE_LIMITS, DEFAULT_RESOURCE_LIMITS } from '../limits.js';
import { createFilterChain, validateFilterChain, type ByteSink, type FilterSpec } from './xzFilters.js';

export type XzDecompressOptions = {
  signal?: AbortSignal;
  maxOutputBytes?: bigint | number;
  maxCompressionRatio?: number;
  maxDictionaryBytes?: bigint | number;
  maxBufferedInputBytes?: number;
  profile?: CompressionProfile;
};

export type XzLimitOptions = {
  maxDictionaryBytes?: bigint | number;
  maxBufferedInputBytes?: number;
  profile?: CompressionProfile;
};

const HEADER_MAGIC = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const FOOTER_MAGIC = new Uint8Array([0x59, 0x5a]);
const OUTPUT_CHUNK_SIZE = 32 * 1024;
const DEFAULT_MAX_BUFFERED_INPUT = DEFAULT_RESOURCE_LIMITS.maxXzBufferedBytes;

type ResolvedOptions = {
  signal?: AbortSignal;
  maxOutputBytes?: bigint;
  maxCompressionRatio?: number;
  maxDictionaryBytes: bigint;
  maxBufferedInputBytes: number;
  profile: CompressionProfile;
};

type XzDebugHook = {
  maxBufferedInputBytes?: number;
  maxDictionaryBytesUsed?: number;
  totalBytesIn?: number;
  totalBytesOut?: number;
};

type BlockRecord = {
  unpaddedSize: bigint;
  uncompressedSize: bigint;
};

export function createXzDecompressStream(
  options: XzDecompressOptions = {}
): ReadableWritablePair<Uint8Array, Uint8Array> {
  const profile = options.profile ?? 'strict';
  const limitOptions: XzLimitOptions = { profile };
  if (options.maxDictionaryBytes !== undefined) limitOptions.maxDictionaryBytes = options.maxDictionaryBytes;
  if (options.maxBufferedInputBytes !== undefined) limitOptions.maxBufferedInputBytes = options.maxBufferedInputBytes;
  const resolvedLimits = resolveXzLimits(limitOptions);
  const resolved: ResolvedOptions = {
    maxDictionaryBytes: resolvedLimits.maxDictionaryBytes,
    maxBufferedInputBytes: resolvedLimits.maxBufferedInputBytes,
    profile,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: toBigInt(options.maxOutputBytes) } : {}),
    ...(typeof options.maxCompressionRatio === 'number' && Number.isFinite(options.maxCompressionRatio)
      ? options.maxCompressionRatio > 0
        ? { maxCompressionRatio: options.maxCompressionRatio }
        : {}
      : {})
  };
  const debug = (options as { __xzDebug?: XzDebugHook }).__xzDebug;
  let decoder: XzDecoder | null = null;
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      decoder = new XzDecoder(resolved, (part) => emitStable(controller, part), debug);
    },
    transform(chunk) {
      if (options.signal) throwIfAborted(options.signal);
      if (!chunk || chunk.length === 0) return;
      decoder?.push(chunk);
    },
    flush() {
      if (options.signal) throwIfAborted(options.signal);
      decoder?.finish();
    }
  });
}

export function resolveXzLimits(options: XzLimitOptions = {}): {
  maxDictionaryBytes: bigint;
  maxBufferedInputBytes: number;
} {
  const profile = options.profile ?? 'strict';
  return {
    maxDictionaryBytes: resolveMaxDictionaryBytes(options.maxDictionaryBytes, profile),
    maxBufferedInputBytes:
      typeof options.maxBufferedInputBytes === 'number' && Number.isFinite(options.maxBufferedInputBytes)
        ? Math.max(1, Math.floor(options.maxBufferedInputBytes))
        : DEFAULT_MAX_BUFFERED_INPUT
  };
}

export function readXzDictionarySize(data: Uint8Array): number | undefined {
  if (data.length < 12) return undefined;
  for (let i = 0; i < HEADER_MAGIC.length; i += 1) {
    if (data[i] !== HEADER_MAGIC[i]) return undefined;
  }
  let offset = 12;
  if (offset >= data.length) return undefined;
  const headerSizeByte = data[offset]!;
  if (headerSizeByte === 0x00) return undefined;
  const headerSize = (headerSizeByte + 1) * 4;
  if (headerSize < 8 || headerSize > 1024) return undefined;
  if (offset + headerSize > data.length) return undefined;
  const header = data.subarray(offset, offset + headerSize);
  try {
    const storedCrc = readUint32LE(header, header.length - 4);
    const crc = new Crc32();
    crc.update(header.subarray(0, header.length - 4));
    if (crc.digest() !== storedCrc) return undefined;

    let pos = 1;
    const flags = header[pos++]!;
    if ((flags & 0x3c) !== 0) return undefined;
    const filterCount = (flags & 0x03) + 1;
    if (filterCount > 4) return undefined;

    const hasCompressedSize = (flags & 0x40) !== 0;
    const hasUncompressedSize = (flags & 0x80) !== 0;
    if (hasCompressedSize) {
      const read = readVliFromBuffer(header, pos);
      pos = read.offset;
    }
    if (hasUncompressedSize) {
      const read = readVliFromBuffer(header, pos);
      pos = read.offset;
    }

    const filters: FilterSpec[] = [];
    for (let i = 0; i < filterCount; i += 1) {
      const id = readVliFromBuffer(header, pos);
      pos = id.offset;
      const propsSize = readVliFromBuffer(header, pos);
      pos = propsSize.offset;
      const propsBytes = toNumberOrThrow(propsSize.value, 'Filter property size');
      if (pos + propsBytes > header.length - 4) return undefined;
      const props = header.subarray(pos, pos + propsBytes);
      pos += propsBytes;
      filters.push({ id: id.value, props });
    }
    const { lzma2Props } = validateFilterChain(filters);
    return decodeDictionarySize(lzma2Props);
  } catch {
    return undefined;
  }
}

type BlockState = {
  headerSize: number;
  expectedCompressed?: number;
  expectedUncompressed?: bigint;
  compressedConsumed: number;
  outputStart: bigint;
  check: DataCheck | null;
  filterSink: ByteSink;
  lzma2: Lzma2StreamDecoder;
  paddingBytes: number;
};

type IndexState = {
  startOffset: number;
  crc: Crc32;
  recordCount: number | null;
  recordsRead: number;
  paddingRemaining: number | null;
  indicatorRead: boolean;
  pendingUnpadded: { value: bigint; bytes: Uint8Array } | null;
};

type XzState =
  | 'stream-header'
  | 'block-header'
  | 'block-data'
  | 'block-padding'
  | 'block-check'
  | 'index'
  | 'footer'
  | 'stream-padding'
  | 'done';

class XzDecoder {
  private readonly queue: ByteQueue;
  private readonly output: OutputSink;
  private readonly debug: XzDebugHook | undefined;
  private readonly blocks: BlockRecord[] = [];
  private streamFlags: Uint8Array = new Uint8Array(2);
  private checkType = 0;
  private checkSize = 0;
  private skipCheck = false;
  private state: XzState = 'stream-header';
  private block: BlockState | null = null;
  private index: IndexState | null = null;
  private indexSize = 0;
  private streamStartOffset = 0;
  private streamPaddingRemaining: number | null = null;
  private bytesIn = 0;
  private done = false;

  constructor(
    private readonly options: ResolvedOptions,
    emit: (chunk: Uint8Array) => void,
    debug?: XzDebugHook
  ) {
    this.debug = debug;
    this.queue = new ByteQueue(debug);
    this.output = new OutputSink(emit, options, debug);
    if (this.debug) {
      if (this.debug.totalBytesIn === undefined) this.debug.totalBytesIn = 0;
      if (this.debug.totalBytesOut === undefined) this.debug.totalBytesOut = 0;
    }
  }

  push(chunk: Uint8Array): void {
    this.bytesIn += chunk.length;
    if (this.debug) this.debug.totalBytesIn = this.bytesIn;
    this.queue.push(chunk);
    this.process();
    this.enforceBufferLimit();
  }

  finish(): void {
    this.queue.markDone();
    this.process();
    this.enforceBufferLimit();
    if (!this.done) {
      throw xzTruncated('Unexpected end of XZ stream');
    }
    this.output.flush();
    this.output.verifyRatio(this.bytesIn, this.options.maxCompressionRatio);
  }

  private enforceBufferLimit(): void {
    if (this.queue.length > this.options.maxBufferedInputBytes) {
      throw new CompressionError('COMPRESSION_XZ_BUFFER_LIMIT', 'XZ buffered input exceeds limit', {
        algorithm: 'xz'
      });
    }
  }

  private process(): void {
    while (true) {
      const progressed = (() => {
        switch (this.state) {
          case 'stream-header':
            return this.readStreamHeader();
          case 'block-header':
            return this.readBlockHeader();
          case 'block-data':
            return this.decodeBlockData();
          case 'block-padding':
            return this.readBlockPadding();
          case 'block-check':
            return this.readBlockCheck();
          case 'index':
            return this.decodeIndex();
          case 'footer':
            return this.decodeFooter();
          case 'stream-padding':
            return this.decodeStreamPadding();
          case 'done':
            return false;
        }
      })();
      if (!progressed) return;
    }
  }

  private readStreamHeader(): boolean {
    const header = this.queue.readBytes(12);
    if (!header) {
      if (this.queue.done) throw xzTruncated('Truncated XZ stream header');
      return false;
    }
    this.streamStartOffset = this.queue.totalRead - 12;
    const magic = header.subarray(0, 6);
    if (!matches(magic, HEADER_MAGIC)) {
      throw xzBadData('Invalid XZ header magic');
    }
    const flags = header.subarray(6, 8);
    if (flags[0] !== 0x00 || (flags[1]! & 0xf0) !== 0) {
      throw xzBadData('Invalid XZ stream flags');
    }
    const storedCrc = readUint32LE(header, 8);
    const crc = new Crc32();
    crc.update(flags);
    if (crc.digest() !== storedCrc) {
      throw xzBadData('XZ stream header CRC mismatch');
    }
    const checkType = flags[1]! & 0x0f;
    const checkSize = checkSizeForId(checkType);
    const supported = isSupportedCheckType(checkType);
    if (!supported && this.options.profile !== 'compat') {
      throw new CompressionError(
        'COMPRESSION_XZ_UNSUPPORTED_CHECK',
        `XZ check type ${describeCheck(checkType)} is not supported`,
        { algorithm: 'xz' }
      );
    }
    this.streamFlags = flags;
    this.checkType = checkType;
    this.checkSize = checkSize;
    this.skipCheck = !supported;
    this.blocks.length = 0;
    this.indexSize = 0;
    this.streamPaddingRemaining = null;
    this.state = 'block-header';
    return true;
  }

  private readBlockHeader(): boolean {
    const peek = this.queue.peekByte();
    if (peek === null) {
      if (this.queue.done) throw xzTruncated('Missing XZ index');
      return false;
    }
    if (peek === 0x00) {
      this.state = 'index';
      this.index = {
        startOffset: this.queue.totalRead,
        crc: new Crc32(),
        recordCount: null,
        recordsRead: 0,
        paddingRemaining: null,
        indicatorRead: false,
        pendingUnpadded: null
      };
      return true;
    }
    const headerSizeByte = peek;
    if (headerSizeByte === 0x00) {
      throw xzBadData('Unexpected index indicator in block header');
    }
    const headerSize = (headerSizeByte + 1) * 4;
    if (headerSize < 8 || headerSize > 1024) {
      throw xzBadData('Invalid XZ block header size');
    }
    if (this.queue.length < headerSize) {
      if (this.queue.done) throw xzTruncated('Truncated XZ block header');
      return false;
    }
    const header = this.queue.readBytes(headerSize)!;
    const storedCrc = readUint32LE(header, header.length - 4);
    const crc = new Crc32();
    crc.update(header.subarray(0, header.length - 4));
    if (crc.digest() !== storedCrc) {
      throw xzBadData('XZ block header CRC mismatch');
    }

    let offset = 1;
    const flags = header[offset++]!;
    if ((flags & 0x3c) !== 0) {
      throw new CompressionError('COMPRESSION_XZ_UNSUPPORTED_FILTER', 'XZ block header uses unsupported filter flags', {
        algorithm: 'xz'
      });
    }
    const filterCount = (flags & 0x03) + 1;
    if (filterCount > 4) {
      throw xzBadData('Invalid XZ filter count');
    }
    const hasCompressedSize = (flags & 0x40) !== 0;
    const hasUncompressedSize = (flags & 0x80) !== 0;

    let compressedSizeValue: bigint | undefined;
    if (hasCompressedSize) {
      const read = readVliFromBuffer(header, offset);
      compressedSizeValue = read.value;
      offset = read.offset;
    }
    let uncompressedSizeValue: bigint | undefined;
    if (hasUncompressedSize) {
      const read = readVliFromBuffer(header, offset);
      uncompressedSizeValue = read.value;
      offset = read.offset;
    }

    const filters: FilterSpec[] = [];
    for (let i = 0; i < filterCount; i += 1) {
      const id = readVliFromBuffer(header, offset);
      offset = id.offset;
      const propsSize = readVliFromBuffer(header, offset);
      offset = propsSize.offset;
      const propsBytes = toNumberOrThrow(propsSize.value, 'Filter property size');
      if (offset + propsBytes > header.length - 4) {
        throw xzBadData('XZ filter properties exceed header size');
      }
      const props = header.subarray(offset, offset + propsBytes);
      offset += propsBytes;
      filters.push({ id: id.value, props });
    }

    for (let i = offset; i < header.length - 4; i += 1) {
      if (header[i] !== 0x00) {
        throw xzBadData('Non-zero bytes in XZ block header padding');
      }
    }

    const { lzma2Props } = validateFilterChain(filters);
    const dictionarySize = decodeDictionarySize(lzma2Props);
    if (this.debug) {
      const current = this.debug.maxDictionaryBytesUsed ?? 0;
      if (dictionarySize > current) this.debug.maxDictionaryBytesUsed = dictionarySize;
    }
    if (BigInt(dictionarySize) > this.options.maxDictionaryBytes) {
      throw new CompressionError(
        'COMPRESSION_RESOURCE_LIMIT',
        `XZ dictionary size ${dictionarySize} exceeds limit`,
        {
          algorithm: 'xz',
          context: {
            requiredDictionaryBytes: String(dictionarySize),
            limitDictionaryBytes: this.options.maxDictionaryBytes.toString()
          }
        }
      );
    }

    const expectedCompressed =
      compressedSizeValue !== undefined ? toNumberOrThrow(compressedSizeValue, 'Compressed size') : undefined;
    const expectedUncompressed = uncompressedSizeValue;

    if (expectedCompressed !== undefined && expectedCompressed <= 0) {
      throw xzBadData('Invalid XZ block compressed size');
    }

    const check = createCheck(this.checkType, this.skipCheck);
    this.output.setCheck(check);
    const outputStart = this.output.totalOut;
    const filterSink = createFilterChain(filters.slice(0, -1), this.output);
    const lzma2 = new Lzma2StreamDecoder(dictionarySize, filterSink, this.options.signal);
    if (expectedCompressed !== undefined) {
      lzma2.setCompressedLimit(expectedCompressed);
    }

    const block: BlockState = {
      headerSize,
      compressedConsumed: 0,
      outputStart,
      check,
      filterSink,
      lzma2,
      paddingBytes: 0,
      ...(expectedCompressed !== undefined ? { expectedCompressed } : {}),
      ...(expectedUncompressed !== undefined ? { expectedUncompressed } : {})
    };
    this.block = block;
    this.state = 'block-data';
    return true;
  }

  private decodeBlockData(): boolean {
    if (!this.block) return false;
    const done = this.block.lzma2.process(this.queue);
    if (!done) {
      if (this.queue.done) throw xzTruncated('Truncated XZ block data');
      return false;
    }
    this.block.filterSink.flush();
    const compressedConsumed = this.block.lzma2.bytesConsumed;
    this.block.compressedConsumed = compressedConsumed;

    if (this.block.expectedCompressed !== undefined && compressedConsumed !== this.block.expectedCompressed) {
      throw xzBadData('XZ block compressed size mismatch');
    }
    const actualUncompressed = this.output.totalOut - this.block.outputStart;
    if (this.block.expectedUncompressed !== undefined && actualUncompressed !== this.block.expectedUncompressed) {
      throw xzBadData('XZ block uncompressed size mismatch');
    }
    this.block.paddingBytes = (4 - (compressedConsumed % 4)) & 3;
    this.state = 'block-padding';
    return true;
  }

  private readBlockPadding(): boolean {
    if (!this.block) return false;
    if (this.block.paddingBytes === 0) {
      this.state = 'block-check';
      return true;
    }
    if (this.queue.length < this.block.paddingBytes) {
      if (this.queue.done) throw xzTruncated('Truncated XZ block padding');
      return false;
    }
    const pad = this.queue.readBytes(this.block.paddingBytes)!;
    for (const byte of pad) {
      if (byte !== 0x00) throw xzBadData('Non-zero bytes in XZ block padding');
    }
    this.state = 'block-check';
    return true;
  }

  private readBlockCheck(): boolean {
    if (!this.block) return false;
    if (this.checkSize > 0) {
      if (this.queue.length < this.checkSize) {
        if (this.queue.done) throw xzTruncated('Truncated XZ block check');
        return false;
      }
      const stored = this.queue.readBytes(this.checkSize)!;
      if (!this.skipCheck) {
        const computed = this.block.check?.digestBytes() ?? new Uint8Array();
        if (!matches(stored, computed)) {
          throw new CompressionError('COMPRESSION_XZ_BAD_CHECK', 'XZ check mismatch', {
            algorithm: 'xz',
            context: { check: describeCheck(this.checkType) }
          });
        }
      }
    }
    this.output.clearCheck();

    const unpaddedSize = BigInt(this.block.headerSize + this.block.compressedConsumed + this.checkSize);
    const uncompressedSize = this.output.totalOut - this.block.outputStart;
    this.blocks.push({ unpaddedSize, uncompressedSize });

    this.block = null;
    this.state = 'block-header';
    return true;
  }

  private decodeIndex(): boolean {
    if (!this.index) {
      this.index = {
        startOffset: this.queue.totalRead,
        crc: new Crc32(),
        recordCount: null,
        recordsRead: 0,
        paddingRemaining: null,
        indicatorRead: false,
        pendingUnpadded: null
      };
    }
    const index = this.index;

    if (index.recordCount === null) {
      if (!index.indicatorRead) {
        const indicator = this.queue.readByte();
        if (indicator === null) {
          if (this.queue.done) throw xzTruncated('Missing XZ index indicator');
          return false;
        }
        if (indicator !== 0x00) {
          throw xzBadData('Missing XZ index indicator');
        }
        index.crc.update(new Uint8Array([indicator]));
        index.indicatorRead = true;
      }
      const vli = tryReadVliWithBytes(this.queue);
      if (!vli) {
        if (this.queue.done) throw xzTruncated('Truncated XZ index');
        return false;
      }
      index.crc.update(vli.bytes);
      index.recordCount = toNumberOrThrow(vli.value, 'Index record count');
      if (index.recordCount !== this.blocks.length) {
        throw xzBadData('XZ index record count mismatch');
      }
    }

    while (index.recordsRead < index.recordCount) {
      let unpadded = index.pendingUnpadded;
      if (!unpadded) {
        const read = tryReadVliWithBytes(this.queue);
        if (!read) {
          if (this.queue.done) throw xzTruncated('Truncated XZ index record');
          return false;
        }
        index.crc.update(read.bytes);
        unpadded = read;
        index.pendingUnpadded = read;
      }
      const uncompressed = tryReadVliWithBytes(this.queue);
      if (!uncompressed) {
        if (this.queue.done) throw xzTruncated('Truncated XZ index record');
        return false;
      }
      index.crc.update(uncompressed.bytes);
      const expected = this.blocks[index.recordsRead]!;
      if (unpadded.value !== expected.unpaddedSize || uncompressed.value !== expected.uncompressedSize) {
        throw xzBadData('XZ index entries do not match decoded blocks');
      }
      index.recordsRead += 1;
      index.pendingUnpadded = null;
    }

    if (index.paddingRemaining === null) {
      const bytesSoFar = this.queue.totalRead - index.startOffset;
      index.paddingRemaining = (4 - (bytesSoFar % 4)) & 3;
    }

    while (index.paddingRemaining > 0) {
      const byte = this.queue.readByte();
      if (byte === null) {
        if (this.queue.done) throw xzTruncated('Truncated XZ index padding');
        return false;
      }
      index.crc.update(new Uint8Array([byte]));
      if (byte !== 0x00) throw xzBadData('Non-zero bytes in XZ index padding');
      index.paddingRemaining -= 1;
    }

    if (this.queue.length < 4) {
      if (this.queue.done) throw xzTruncated('Truncated XZ index');
      return false;
    }
    const storedBytes = this.queue.readBytes(4)!;
    const storedCrc = readUint32LE(storedBytes, 0);
    if (index.crc.digest() !== storedCrc) {
      throw xzBadData('XZ index CRC mismatch');
    }
    this.indexSize = this.queue.totalRead - index.startOffset;
    this.index = null;
    this.state = 'footer';
    return true;
  }

  private decodeFooter(): boolean {
    if (this.queue.length < 12) {
      if (this.queue.done) throw xzTruncated('Truncated XZ stream footer');
      return false;
    }
    const footer = this.queue.readBytes(12)!;
    const storedCrc = readUint32LE(footer, 0);
    const backwardSize = readUint32LE(footer, 4);
    const flags = footer.subarray(8, 10);
    const magic = footer.subarray(10, 12);
    if (!matches(magic, FOOTER_MAGIC)) {
      throw xzBadData('Invalid XZ footer magic');
    }
    if (!matches(flags, this.streamFlags)) {
      throw xzBadData('XZ stream footer flags mismatch');
    }
    const crc = new Crc32();
    crc.update(footer.subarray(4, 10));
    if (crc.digest() !== storedCrc) {
      throw xzBadData('XZ stream footer CRC mismatch');
    }
    const realBackwardSize = (backwardSize + 1) * 4;
    if (realBackwardSize !== this.indexSize) {
      throw xzBadData('XZ backward size mismatch');
    }
    this.streamPaddingRemaining = null;
    this.state = 'stream-padding';
    return true;
  }

  private decodeStreamPadding(): boolean {
    if (this.streamPaddingRemaining === null) {
      const streamBytes = this.queue.totalRead - this.streamStartOffset;
      this.streamPaddingRemaining = (4 - (streamBytes % 4)) & 3;
    }

    while (this.streamPaddingRemaining > 0) {
      const byte = this.queue.readByte();
      if (byte === null) {
        if (this.queue.done) throw xzTruncated('Truncated XZ stream padding');
        return false;
      }
      if (byte !== 0x00) {
        throw xzBadData('Non-zero bytes found after XZ stream');
      }
      this.streamPaddingRemaining -= 1;
    }

    while (true) {
      if (this.queue.length < 4) {
        if (this.queue.done) {
          if (this.queue.length === 0) {
            this.state = 'done';
            this.done = true;
            return true;
          }
          const tail = this.queue.readBytes(this.queue.length)!;
          for (const byte of tail) {
            if (byte !== 0x00) {
              throw xzBadData('Non-zero bytes found after XZ stream');
            }
          }
          throw xzBadData('Invalid XZ stream padding length');
        }
        return false;
      }
      const padding = this.queue.peekBytes(4)!;
      if (padding[0] === 0x00 && padding[1] === 0x00 && padding[2] === 0x00 && padding[3] === 0x00) {
        this.queue.readBytes(4);
        continue;
      }
      this.streamPaddingRemaining = null;
      this.state = 'stream-header';
      return true;
    }
  }
}

class ByteQueue {
  private readonly chunks: Uint8Array[] = [];
  private offset = 0;
  length = 0;
  totalRead = 0;
  done = false;
  private maxBuffered = 0;

  constructor(private readonly debug?: XzDebugHook) {}

  push(chunk: Uint8Array): void {
    if (!chunk || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    if (this.length > this.maxBuffered) {
      this.maxBuffered = this.length;
      if (this.debug) this.debug.maxBufferedInputBytes = this.maxBuffered;
    }
  }

  markDone(): void {
    this.done = true;
  }

  peekByte(): number | null {
    if (this.length === 0) return null;
    const chunk = this.chunks[0]!;
    return chunk[this.offset]!;
  }

  readByte(): number | null {
    if (this.length === 0) return null;
    const chunk = this.chunks[0]!;
    const value = chunk[this.offset]!;
    this.offset += 1;
    this.length -= 1;
    this.totalRead += 1;
    if (this.offset >= chunk.length) {
      this.chunks.shift();
      this.offset = 0;
    }
    return value;
  }

  readBytes(length: number): Uint8Array | null {
    if (length === 0) return new Uint8Array(0);
    if (this.length < length) return null;
    const first = this.chunks[0]!;
    const available = first.length - this.offset;
    if (available >= length) {
      const out = first.subarray(this.offset, this.offset + length);
      this.offset += length;
      this.length -= length;
      this.totalRead += length;
      if (this.offset >= first.length) {
        this.chunks.shift();
        this.offset = 0;
      }
      return out;
    }
    const out = new Uint8Array(length);
    let offset = 0;
    let remaining = length;
    while (remaining > 0) {
      const chunk = this.chunks[0]!;
      const take = Math.min(chunk.length - this.offset, remaining);
      out.set(chunk.subarray(this.offset, this.offset + take), offset);
      this.offset += take;
      this.length -= take;
      this.totalRead += take;
      offset += take;
      remaining -= take;
      if (this.offset >= chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return out;
  }

  peekBytes(length: number): Uint8Array | null {
    if (length === 0) return new Uint8Array(0);
    if (this.length < length) return null;
    const out = new Uint8Array(length);
    let offset = 0;
    let remaining = length;
    let chunkIndex = 0;
    let chunkOffset = this.offset;
    while (remaining > 0) {
      const chunk = this.chunks[chunkIndex]!;
      const take = Math.min(chunk.length - chunkOffset, remaining);
      out.set(chunk.subarray(chunkOffset, chunkOffset + take), offset);
      offset += take;
      remaining -= take;
      chunkIndex += 1;
      chunkOffset = 0;
    }
    return out;
  }
}

class Lzma2StreamDecoder {
  private needDictionaryReset = true;
  private needProperties = true;
  private readonly dict: Dictionary;
  private readonly lzma: LzmaDecoder;
  private state: 'control' | 'lzma-header' | 'lzma-data' | 'uncompressed-header' | 'uncompressed-data' = 'control';
  private control = 0;
  private uncompressedSize = 0;
  private compressedSize = 0;
  private expectedCompressed: number | undefined;
  private compressedConsumed = 0;

  constructor(dictionarySize: number, output: ByteSink, signal?: AbortSignal) {
    this.dict = new Dictionary(dictionarySize, output, signal);
    this.lzma = new LzmaDecoder(this.dict, signal);
  }

  setCompressedLimit(limit: number): void {
    this.expectedCompressed = limit;
  }

  get bytesConsumed(): number {
    return this.compressedConsumed;
  }

  process(queue: ByteQueue): boolean {
    while (true) {
      if (this.state === 'control') {
        const control = this.readByte(queue);
        if (control === null) return false;
        this.control = control;
        if (control === 0x00) return true;
        if (control >= 0xe0 || control === 0x01) {
          this.needProperties = true;
          this.needDictionaryReset = true;
        } else if (this.needDictionaryReset) {
          throw lzmaBadData('LZMA2 dictionary reset missing');
        }
        this.state = control >= 0x80 ? 'lzma-header' : 'uncompressed-header';
      }

      if (this.state === 'lzma-header') {
        const needsProps = this.control >= 0xc0;
        const header = this.readBytes(queue, needsProps ? 5 : 4);
        if (!header) return false;
        const control = this.control;
        const uncompressedSize = (((control & 0x1f) << 16) | (header[0]! << 8) | header[1]!) + 1;
        const compressedSize = ((header[2]! << 8) | header[3]!) + 1;
        if (compressedSize <= 0) throw lzmaBadData('Invalid LZMA2 compressed size');
        if (needsProps) {
          const props = header[4]!;
          this.lzma.resetProperties(props);
          this.needProperties = false;
        } else if (this.needProperties) {
          throw lzmaBadData('Missing LZMA2 properties');
        } else if (control >= 0xa0) {
          this.lzma.resetState();
        }

        if (this.needDictionaryReset) {
          this.dict.reset();
          this.needDictionaryReset = false;
        }

        this.uncompressedSize = uncompressedSize;
        this.compressedSize = compressedSize;
        this.state = 'lzma-data';
      }

      if (this.state === 'lzma-data') {
        const data = this.readBytes(queue, this.compressedSize);
        if (!data) return false;
        const range = new RangeDecoder(data, 0, this.compressedSize);
        this.lzma.decode(range, this.uncompressedSize);
        if (range.position !== range.limit) {
          throw lzmaBadData('LZMA2 chunk has unused compressed bytes');
        }
        this.state = 'control';
      }

      if (this.state === 'uncompressed-header') {
        const header = this.readBytes(queue, 2);
        if (!header) return false;
        const control = this.control;
        if (control > 0x02) throw lzmaBadData('Invalid LZMA2 control byte');
        const size = ((header[0]! << 8) | header[1]!) + 1;
        if (this.needDictionaryReset) {
          this.dict.reset();
          this.needDictionaryReset = false;
        }
        this.uncompressedSize = size;
        this.state = 'uncompressed-data';
      }

      if (this.state === 'uncompressed-data') {
        const data = this.readBytes(queue, this.uncompressedSize);
        if (!data) return false;
        this.dict.copyUncompressed(data);
        this.state = 'control';
      }
    }
  }

  private readByte(queue: ByteQueue): number | null {
    if (this.expectedCompressed !== undefined && this.compressedConsumed >= this.expectedCompressed) {
      throw xzBadData('XZ block compressed size mismatch');
    }
    const byte = queue.readByte();
    if (byte === null) return null;
    this.compressedConsumed += 1;
    return byte;
  }

  private readBytes(queue: ByteQueue, length: number): Uint8Array | null {
    if (this.expectedCompressed !== undefined && this.compressedConsumed + length > this.expectedCompressed) {
      throw xzBadData('XZ block compressed size mismatch');
    }
    const bytes = queue.readBytes(length);
    if (!bytes) return null;
    this.compressedConsumed += length;
    return bytes;
  }
}

class LzmaDecoder {
  private lc = 0;
  private lp = 0;
  private pb = 0;
  private state = 0;
  private reps: [number, number, number, number] = [0, 0, 0, 0];

  private readonly isMatch = new Uint16Array(K_NUM_STATES * K_NUM_POS_STATES_MAX);
  private readonly isRep = new Uint16Array(K_NUM_STATES);
  private readonly isRepG0 = new Uint16Array(K_NUM_STATES);
  private readonly isRepG1 = new Uint16Array(K_NUM_STATES);
  private readonly isRepG2 = new Uint16Array(K_NUM_STATES);
  private readonly isRep0Long = new Uint16Array(K_NUM_STATES * K_NUM_POS_STATES_MAX);
  private readonly posSlot = new Uint16Array(K_NUM_LEN_TO_POS_STATES * (1 << K_NUM_POS_SLOT_BITS));
  private readonly posDecoders = new Uint16Array(K_NUM_FULL_DISTANCES);
  private readonly align = new Uint16Array(1 << K_NUM_ALIGN_BITS);
  private readonly lenDecoder = new LenDecoder();
  private readonly repLenDecoder = new LenDecoder();
  private literalProbs = new Uint16Array(0);

  constructor(
    private readonly dict: Dictionary,
    private readonly signal?: AbortSignal
  ) {}

  resetProperties(props: number): void {
    const lc = props % 9;
    let rest = Math.floor(props / 9);
    const lp = rest % 5;
    const pb = Math.floor(rest / 5);
    if (pb > 4) throw lzmaBadData('Invalid LZMA properties');
    if (lc + lp > 4) throw lzmaBadData('Unsupported LZMA2 properties (lc + lp > 4)');
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
    this.literalProbs = new Uint16Array(0x300 << (lc + lp));
    initProbs(this.literalProbs);
    initProbs(this.isMatch);
    initProbs(this.isRep);
    initProbs(this.isRepG0);
    initProbs(this.isRepG1);
    initProbs(this.isRepG2);
    initProbs(this.isRep0Long);
    initProbs(this.posSlot);
    initProbs(this.posDecoders);
    initProbs(this.align);
    this.lenDecoder.reset();
    this.repLenDecoder.reset();
    this.resetState();
  }

  resetState(): void {
    this.state = 0;
    this.reps = [0, 0, 0, 0];
  }

  decode(range: RangeDecoder, expectedOutput: number): void {
    const target = this.dict.written + expectedOutput;
    const pbMask = (1 << this.pb) - 1;
    while (this.dict.written < target) {
      if (this.signal && (this.dict.written & 0x3fff) === 0) {
        throwIfAborted(this.signal);
      }
      const posState = this.dict.written & pbMask;
      const stateIndex = this.state << K_NUM_POS_BITS_MAX;
      const isMatch = range.decodeBit(this.isMatch, stateIndex + posState);
      if (isMatch === 0) {
        const prevByte = this.dict.getPrevByte();
        const context = ((this.dict.written & ((1 << this.lp) - 1)) << this.lc) + (prevByte >> (8 - this.lc));
        const base = context * 0x300;
        const symbol =
          this.state < K_NUM_LIT_STATES
            ? decodeLiteral(range, this.literalProbs, base)
            : decodeMatchedLiteral(range, this.literalProbs, base, this.dict.getByte(this.reps[0] + 1));
        if (this.dict.written + 1 > target) throw lzmaBadData('LZMA output exceeds expected size');
        this.dict.putByte(symbol);
        this.state = updateStateLiteral(this.state);
        continue;
      }

      const isRep = range.decodeBit(this.isRep, this.state);
      let length: number;
      if (isRep === 1) {
        if (range.decodeBit(this.isRepG0, this.state) === 0) {
          if (range.decodeBit(this.isRep0Long, stateIndex + posState) === 0) {
            if (this.dict.written + 1 > target) throw lzmaBadData('LZMA output exceeds expected size');
            this.dict.putByte(this.dict.getByte(this.reps[0] + 1));
            this.state = updateStateShortRep(this.state);
            continue;
          }
        } else {
          let distance: number;
          const [rep0, rep1, rep2, rep3] = this.reps;
          if (range.decodeBit(this.isRepG1, this.state) === 0) {
            distance = rep1;
            this.reps = [distance, rep0, rep2, rep3];
          } else if (range.decodeBit(this.isRepG2, this.state) === 0) {
            distance = rep2;
            this.reps = [distance, rep0, rep1, rep3];
          } else {
            distance = rep3;
            this.reps = [distance, rep0, rep1, rep2];
          }
        }
        length = this.repLenDecoder.decode(range, posState) + K_MATCH_MIN_LEN;
        this.state = updateStateRep(this.state);
      } else {
        length = this.lenDecoder.decode(range, posState) + K_MATCH_MIN_LEN;
        const lenToPosState = (length - K_MATCH_MIN_LEN) < K_NUM_LEN_TO_POS_STATES ? length - K_MATCH_MIN_LEN : K_NUM_LEN_TO_POS_STATES - 1;
        const posSlot = decodeBitTree(range, this.posSlot, lenToPosState << K_NUM_POS_SLOT_BITS, K_NUM_POS_SLOT_BITS);
        let distance: number;
        if (posSlot < 4) {
          distance = posSlot;
        } else {
          const directBits = (posSlot >> 1) - 1;
          distance = (2 | (posSlot & 1)) << directBits;
          if (posSlot < K_END_POS_MODEL_INDEX) {
            distance += decodeReverseBitTree(range, this.posDecoders, distance - posSlot, directBits);
          } else {
            distance += range.decodeDirectBits(directBits - K_NUM_ALIGN_BITS) << K_NUM_ALIGN_BITS;
            distance += decodeReverseBitTree(range, this.align, 0, K_NUM_ALIGN_BITS);
          }
        }
        this.reps = [distance, this.reps[0], this.reps[1], this.reps[2]];
        this.state = updateStateMatch(this.state);
      }

      if (this.dict.written + length > target) {
        throw lzmaBadData('LZMA output exceeds expected size');
      }
      this.dict.copyMatch(this.reps[0] + 1, length);
    }
  }
}

class LenDecoder {
  private readonly choice = new Uint16Array(2);
  private readonly low = new Uint16Array(K_NUM_POS_STATES_MAX << K_LEN_NUM_LOW_BITS);
  private readonly mid = new Uint16Array(K_NUM_POS_STATES_MAX << K_LEN_NUM_LOW_BITS);
  private readonly high = new Uint16Array(K_LEN_NUM_HIGH_SYMBOLS);

  reset(): void {
    initProbs(this.choice);
    initProbs(this.low);
    initProbs(this.mid);
    initProbs(this.high);
  }

  decode(range: RangeDecoder, posState: number): number {
    if (range.decodeBit(this.choice, 0) === 0) {
      return decodeBitTree(range, this.low, posState << K_LEN_NUM_LOW_BITS, K_LEN_NUM_LOW_BITS);
    }
    if (range.decodeBit(this.choice, 1) === 0) {
      return K_LEN_NUM_LOW_SYMBOLS + decodeBitTree(range, this.mid, posState << K_LEN_NUM_LOW_BITS, K_LEN_NUM_LOW_BITS);
    }
    return K_LEN_NUM_LOW_SYMBOLS * 2 + decodeBitTree(range, this.high, 0, K_LEN_NUM_HIGH_BITS);
  }
}

class Dictionary {
  private readonly buffer: Uint8Array;
  private pos = 0;
  private full = false;
  written = 0;
  private byteCounter = 0;

  constructor(
    size: number,
    private readonly output: ByteSink,
    private readonly signal?: AbortSignal
  ) {
    this.buffer = new Uint8Array(size);
  }

  reset(): void {
    this.pos = 0;
    this.full = false;
    this.written = 0;
  }

  getPrevByte(): number {
    if (this.written === 0) return 0;
    const index = this.pos === 0 ? this.buffer.length - 1 : this.pos - 1;
    return this.buffer[index]!;
  }

  getByte(distance: number): number {
    if (distance <= 0 || distance > this.buffer.length) {
      throw lzmaBadData(
        `LZMA distance out of range (distance=${distance}, size=${this.buffer.length})`
      );
    }
    if (!this.full && distance > this.pos) {
      throw lzmaBadData(
        `LZMA distance exceeds dictionary (distance=${distance}, pos=${this.pos})`
      );
    }
    let index = this.pos - distance;
    if (index < 0) index += this.buffer.length;
    return this.buffer[index]!;
  }

  putByte(value: number): void {
    this.buffer[this.pos] = value;
    this.pos += 1;
    if (this.pos >= this.buffer.length) {
      this.pos = 0;
      this.full = true;
    }
    this.written += 1;
    this.output.writeByte(value);
    this.checkAbort();
  }

  copyMatch(distance: number, length: number): void {
    if (distance <= 0 || distance > this.buffer.length) {
      throw lzmaBadData('LZMA distance out of range');
    }
    if (!this.full && distance > this.pos) {
      throw lzmaBadData('LZMA distance exceeds dictionary');
    }
    let src = this.pos - distance;
    if (src < 0) src += this.buffer.length;
    for (let i = 0; i < length; i += 1) {
      const value = this.buffer[src]!;
      this.buffer[this.pos] = value;
      this.pos += 1;
      if (this.pos >= this.buffer.length) {
        this.pos = 0;
        this.full = true;
      }
      src += 1;
      if (src >= this.buffer.length) src = 0;
      this.written += 1;
      this.output.writeByte(value);
      this.checkAbort();
    }
  }

  copyUncompressed(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length; i += 1) {
      this.buffer[this.pos] = chunk[i]!;
      this.pos += 1;
      if (this.pos >= this.buffer.length) {
        this.pos = 0;
        this.full = true;
      }
      this.written += 1;
      this.output.writeByte(chunk[i]!);
      this.checkAbort();
    }
  }

  private checkAbort(): void {
    if (!this.signal) return;
    this.byteCounter = (this.byteCounter + 1) & 0x3fff;
    if (this.byteCounter === 0) throwIfAborted(this.signal);
  }
}

class OutputSink {
  private readonly buffer = new Uint8Array(OUTPUT_CHUNK_SIZE);
  private length = 0;
  private bytesOut = 0n;
  private check: DataCheck | null = null;

  constructor(
    private readonly emit: (chunk: Uint8Array) => void,
    private readonly options: ResolvedOptions,
    private readonly debug?: XzDebugHook
  ) {}

  get totalOut(): bigint {
    return this.bytesOut;
  }

  setCheck(check: DataCheck | null): void {
    this.check = check;
  }

  clearCheck(): void {
    this.check = null;
  }

  writeByte(value: number): void {
    this.buffer[this.length++] = value;
    this.bytesOut += 1n;
    if (this.debug) this.debug.totalBytesOut = Number(this.bytesOut);
    this.ensureLimits();
    if (this.length >= this.buffer.length) this.flush();
  }

  flush(): void {
    if (this.length === 0) return;
    const chunk = this.buffer.subarray(0, this.length);
    this.check?.update(chunk);
    this.emit(chunk);
    this.length = 0;
    if (this.debug) this.debug.totalBytesOut = Number(this.bytesOut);
  }

  private ensureLimits(): void {
    if (this.options.maxOutputBytes !== undefined && this.bytesOut > this.options.maxOutputBytes) {
      throw new CompressionError('COMPRESSION_XZ_LIMIT_EXCEEDED', 'XZ output exceeds maxOutputBytes', {
        algorithm: 'xz'
      });
    }
    if (this.options.signal && (this.bytesOut & 0x3fffn) === 0n) {
      throwIfAborted(this.options.signal);
    }
  }

  verifyRatio(totalIn: number, maxCompressionRatio?: number): void {
    if (!maxCompressionRatio || maxCompressionRatio <= 0) return;
    const limit = BigInt(Math.ceil(totalIn * maxCompressionRatio));
    if (this.bytesOut > limit) {
      throw new CompressionError('COMPRESSION_XZ_LIMIT_EXCEEDED', 'XZ output exceeds maxCompressionRatio', {
        algorithm: 'xz'
      });
    }
  }
}

type DataCheck = {
  update(chunk: Uint8Array): void;
  digestBytes(): Uint8Array;
};

function createCheck(checkType: number, skip: boolean): DataCheck | null {
  if (skip || checkType === 0x00) return null;
  if (checkType === 0x01) {
    const crc = new Crc32();
    return {
      update: (chunk) => crc.update(chunk),
      digestBytes: () => {
        const value = crc.digest();
        const out = new Uint8Array(4);
        out[0] = value & 0xff;
        out[1] = (value >>> 8) & 0xff;
        out[2] = (value >>> 16) & 0xff;
        out[3] = (value >>> 24) & 0xff;
        return out;
      }
    };
  }
  if (checkType === 0x04) {
    const crc = new Crc64();
    return {
      update: (chunk) => crc.update(chunk),
      digestBytes: () => {
        const value = crc.digest();
        const out = new Uint8Array(8);
        const view = new DataView(out.buffer);
        view.setBigUint64(0, value, true);
        return out;
      }
    };
  }
  if (checkType === 0x0a) {
    const sha = new Sha256();
    return {
      update: (chunk) => sha.update(chunk),
      digestBytes: () => sha.digestBytes()
    };
  }
  return null;
}

class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  private pos: number;
  readonly limit: number;

  constructor(private readonly buffer: Uint8Array, start: number, size: number) {
    if (size < 5) throw lzmaBadData('Truncated LZMA stream');
    this.pos = start;
    this.limit = start + size;
    for (let i = 0; i < 5; i += 1) {
      this.code = ((this.code << 8) | this.readByte()) >>> 0;
    }
  }

  get position(): number {
    return this.pos;
  }

  decodeBit(probs: Uint16Array, index: number): number {
    const prob = probs[index]!;
    const bound = ((this.range >>> 11) * prob) >>> 0;
    if (this.code < bound) {
      this.range = bound >>> 0;
      probs[index] = prob + ((2048 - prob) >>> 5);
      this.normalize();
      return 0;
    }
    this.range = (this.range - bound) >>> 0;
    this.code = (this.code - bound) >>> 0;
    probs[index] = prob - (prob >>> 5);
    this.normalize();
    return 1;
  }

  decodeDirectBits(numBits: number): number {
    let result = 0;
    for (let i = 0; i < numBits; i += 1) {
      this.range >>>= 1;
      const t = this.code - this.range;
      if (t >= 0) {
        this.code = t >>> 0;
        result = (result << 1) | 1;
      } else {
        result <<= 1;
      }
      if (this.range < 0x01000000) {
        this.range = (this.range << 8) >>> 0;
        this.code = ((this.code << 8) | this.readByte()) >>> 0;
      }
    }
    return result;
  }

  private normalize(): void {
    if (this.range < 0x01000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.readByte()) >>> 0;
    }
  }

  private readByte(): number {
    if (this.pos >= this.limit) {
      throw lzmaBadData('Truncated LZMA stream');
    }
    return this.buffer[this.pos++]!;
  }
}

const MAX_VLI = (1n << 63n) - 1n;

const K_NUM_POS_BITS_MAX = 4;
const K_NUM_POS_STATES_MAX = 1 << K_NUM_POS_BITS_MAX;
const K_LEN_NUM_LOW_BITS = 3;
const K_LEN_NUM_LOW_SYMBOLS = 1 << K_LEN_NUM_LOW_BITS;
const K_LEN_NUM_HIGH_BITS = 8;
const K_LEN_NUM_HIGH_SYMBOLS = 1 << K_LEN_NUM_HIGH_BITS;
const K_NUM_STATES = 12;
const K_NUM_LIT_STATES = 7;
const K_END_POS_MODEL_INDEX = 14;
const K_NUM_FULL_DISTANCES = 1 << (K_END_POS_MODEL_INDEX >> 1);
const K_NUM_POS_SLOT_BITS = 6;
const K_NUM_LEN_TO_POS_STATES = 4;
const K_NUM_ALIGN_BITS = 4;
const K_MATCH_MIN_LEN = 2;

function initProbs(probs: Uint16Array): void {
  probs.fill(1024);
}

function decodeBitTree(
  range: RangeDecoder,
  probs: Uint16Array,
  offset: number,
  bits: number
): number {
  let symbol = 1;
  for (let i = 0; i < bits; i += 1) {
    symbol = (symbol << 1) | range.decodeBit(probs, offset + symbol);
  }
  return symbol - (1 << bits);
}

function decodeReverseBitTree(
  range: RangeDecoder,
  probs: Uint16Array,
  offset: number,
  bits: number
): number {
  let symbol = 1;
  let result = 0;
  for (let i = 0; i < bits; i += 1) {
    const bit = range.decodeBit(probs, offset + symbol);
    symbol = (symbol << 1) | bit;
    result |= bit << i;
  }
  return result;
}

function decodeLiteral(range: RangeDecoder, probs: Uint16Array, base: number): number {
  let symbol = 1;
  for (let i = 0; i < 8; i += 1) {
    symbol = (symbol << 1) | range.decodeBit(probs, base + symbol);
  }
  return symbol - 0x100;
}

function decodeMatchedLiteral(
  range: RangeDecoder,
  probs: Uint16Array,
  base: number,
  matchByte: number
): number {
  let symbol = 1;
  let match = matchByte;
  while (symbol < 0x100) {
    const matchBit = (match >> 7) & 1;
    match = (match << 1) & 0xff;
    const bit = range.decodeBit(probs, base + 0x100 + (matchBit << 8) + symbol);
    symbol = (symbol << 1) | bit;
    if (matchBit !== bit) {
      while (symbol < 0x100) {
        symbol = (symbol << 1) | range.decodeBit(probs, base + symbol);
      }
      break;
    }
  }
  return symbol - 0x100;
}

function updateStateLiteral(state: number): number {
  if (state < 4) return 0;
  if (state < 10) return state - 3;
  return state - 6;
}

function updateStateMatch(state: number): number {
  return state < 7 ? 7 : 10;
}

function updateStateRep(state: number): number {
  return state < 7 ? 8 : 11;
}

function updateStateShortRep(state: number): number {
  return state < 7 ? 9 : 11;
}

function readVliFromBuffer(
  buffer: Uint8Array,
  start: number
): { value: bigint; offset: number } {
  let offset = start;
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < 9; i += 1) {
    if (offset >= buffer.length - 4) throw xzBadData('XZ block header truncated');
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

function tryReadVliWithBytes(queue: ByteQueue): { value: bigint; bytes: Uint8Array } | null {
  const available = Math.min(queue.length, 9);
  if (available === 0) return null;
  const peek = queue.peekBytes(available);
  if (!peek) return null;
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < peek.length; i += 1) {
    const byte = peek[i]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > MAX_VLI) throw xzBadData('XZ VLI exceeds 63 bits');
      const bytes = queue.readBytes(i + 1)!;
      return { value, bytes };
    }
    shift += 7n;
  }
  if (available < 9) return null;
  throw xzBadData('XZ VLI is too long');
}

function decodeDictionarySize(props: number): number {
  const bits = props & 0x3f;
  if (bits > 40) throw xzBadData('Invalid LZMA2 dictionary size');
  if (bits === 40) return 0xffffffff;
  const base = 2 | (bits & 1);
  const shift = (bits >> 1) + 11;
  return base * 2 ** shift;
}

function resolveMaxDictionaryBytes(value: bigint | number | undefined, profile: CompressionProfile): bigint {
  if (value !== undefined) return toBigInt(value);
  if (profile === 'agent') return toBigInt(AGENT_RESOURCE_LIMITS.maxXzDictionaryBytes);
  return toBigInt(DEFAULT_RESOURCE_LIMITS.maxXzDictionaryBytes);
}

function toBigInt(value: bigint | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function toNumberOrThrow(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw xzBadData(`${label} exceeds safe integer range`);
  }
  return Number(value);
}

function checkSizeForId(id: number): number {
  if (id === 0x00) return 0;
  if (id <= 0x03) return 4;
  if (id <= 0x06) return 8;
  if (id <= 0x09) return 16;
  if (id <= 0x0c) return 32;
  return 64;
}

function isSupportedCheckType(id: number): boolean {
  return id === 0x00 || id === 0x01 || id === 0x04 || id === 0x0a;
}

function describeCheck(id: number): string {
  if (id === 0x00) return 'none';
  if (id === 0x01) return 'crc32';
  if (id === 0x04) return 'crc64';
  if (id === 0x0a) return 'sha256';
  return `0x${id.toString(16)}`;
}

function matches(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function xzBadData(message: string): CompressionError {
  return new CompressionError('COMPRESSION_XZ_BAD_DATA', message, { algorithm: 'xz' });
}

function xzTruncated(message: string): CompressionError {
  return new CompressionError('COMPRESSION_XZ_TRUNCATED', message, { algorithm: 'xz' });
}

function lzmaBadData(message: string): CompressionError {
  return new CompressionError('COMPRESSION_LZMA_BAD_DATA', message, { algorithm: 'xz' });
}
