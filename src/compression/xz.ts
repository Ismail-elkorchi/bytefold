import { throwIfAborted } from '../abort.js';
import { concatBytes, readUint32LE } from '../binary.js';
import { Crc32 } from '../crc32.js';
import { Crc64 } from '../crc64.js';
import { CompressionError } from '../compress/errors.js';
import type { CompressionProfile } from '../compress/types.js';

export type XzDecompressOptions = {
  signal?: AbortSignal;
  maxOutputBytes?: bigint | number;
  maxCompressionRatio?: number;
  maxDictionaryBytes?: bigint | number;
  profile?: CompressionProfile;
};

const HEADER_MAGIC = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const FOOTER_MAGIC = new Uint8Array([0x59, 0x5a]);
const LZMA2_FILTER_ID = 0x21n;
const OUTPUT_CHUNK_SIZE = 32 * 1024;
const DEFAULT_MAX_DICTIONARY = 64 * 1024 * 1024;
const AGENT_MAX_DICTIONARY = 32 * 1024 * 1024;

type ResolvedOptions = {
  signal?: AbortSignal;
  maxOutputBytes?: bigint;
  maxRatioBytes?: bigint;
  maxDictionaryBytes: bigint;
  profile: CompressionProfile;
};

type BlockRecord = {
  unpaddedSize: bigint;
  uncompressedSize: bigint;
};

export function createXzDecompressStream(
  options: XzDecompressOptions = {}
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
      const input = concatBytes(chunks);
      const profile = options.profile ?? 'strict';
      const maxRatioBytes =
        typeof options.maxCompressionRatio === 'number' && Number.isFinite(options.maxCompressionRatio)
          ? options.maxCompressionRatio > 0
            ? BigInt(Math.ceil(totalIn * options.maxCompressionRatio))
            : undefined
          : undefined;
      const resolved: ResolvedOptions = {
        maxDictionaryBytes: resolveMaxDictionaryBytes(options.maxDictionaryBytes, profile),
        profile,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: toBigInt(options.maxOutputBytes) } : {}),
        ...(maxRatioBytes !== undefined ? { maxRatioBytes } : {})
      };
      const decoder = new XzDecoder(input, resolved, (part) => controller.enqueue(part));
      decoder.decode();
    }
  });
}

class XzDecoder {
  private readonly reader: ByteReader;
  private readonly output: OutputSink;
  private readonly blocks: BlockRecord[] = [];
  private readonly streamFlags: Uint8Array;
  private readonly checkType: number;
  private readonly checkSize: number;
  private readonly skipCheck: boolean;

  constructor(
    private readonly input: Uint8Array,
    private readonly options: ResolvedOptions,
    emit: (chunk: Uint8Array) => void
  ) {
    this.reader = new ByteReader(input);
    this.output = new OutputSink(emit, options);
    const { flags, checkType, checkSize, skipCheck } = this.readStreamHeader();
    this.streamFlags = flags;
    this.checkType = checkType;
    this.checkSize = checkSize;
    this.skipCheck = skipCheck;
  }

  decode(): void {
    this.decodeBlocks();
    const indexSize = this.decodeIndex();
    this.decodeFooter(indexSize);
    this.verifyStreamPadding();
    this.output.flush();
  }

  private readStreamHeader(): {
    flags: Uint8Array;
    checkType: number;
    checkSize: number;
    skipCheck: boolean;
  } {
    const magic = this.reader.readBytes(HEADER_MAGIC.length);
    if (!matches(magic, HEADER_MAGIC)) {
      throw xzBadData('Invalid XZ header magic');
    }
    const flags = this.reader.readBytes(2);
    if (flags[0] !== 0x00 || (flags[1]! & 0xf0) !== 0) {
      throw xzBadData('Invalid XZ stream flags');
    }
    const storedCrc = this.reader.readUint32LE();
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
    return { flags, checkType, checkSize, skipCheck: !supported };
  }

  private decodeBlocks(): void {
    while (true) {
      if (this.reader.remaining() <= 0) {
        throw xzBadData('Missing XZ index');
      }
      if (this.reader.peekByte() === 0x00) break;
      this.decodeBlock();
    }
  }

  private decodeBlock(): void {
    const headerStart = this.reader.position;
    const headerSizeByte = this.reader.readByte();
    if (headerSizeByte === 0x00) {
      throw xzBadData('Unexpected index indicator in block header');
    }
    const headerSize = (headerSizeByte + 1) * 4;
    if (headerSize < 8 || headerSize > 1024) {
      throw xzBadData('Invalid XZ block header size');
    }
    const headerEnd = headerStart + headerSize;
    if (headerEnd > this.input.length) {
      throw xzBadData('Truncated XZ block header');
    }
    const header = this.input.subarray(headerStart, headerEnd);
    this.reader.position = headerEnd;

    const storedCrc = readUint32LE(header, header.length - 4);
    const crc = new Crc32();
    crc.update(header.subarray(0, header.length - 4));
    if (crc.digest() !== storedCrc) {
      throw xzBadData('XZ block header CRC mismatch');
    }

    let offset = 1;
    const flags = header[offset++]!;
    if ((flags & 0x3c) !== 0) {
      throw xzBadData('XZ block header uses reserved flags');
    }
    const filterCount = (flags & 0x03) + 1;
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

    let dictProp: number | null = null;
    const filterIds: bigint[] = [];
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
      filterIds.push(id.value);
      if (id.value === LZMA2_FILTER_ID) {
        if (propsBytes !== 1) {
          throw xzBadData('Invalid LZMA2 filter properties');
        }
        dictProp = props[0]!;
      }
    }

    for (let i = offset; i < header.length - 4; i += 1) {
      if (header[i] !== 0x00) {
        throw xzBadData('Non-zero bytes in XZ block header padding');
      }
    }

    if (filterIds.length !== 1 || filterIds[0] !== LZMA2_FILTER_ID || dictProp === null) {
      throw new CompressionError(
        'COMPRESSION_XZ_UNSUPPORTED_FILTER',
        `XZ filter chain unsupported: ${filterIds.map((id) => `0x${id.toString(16)}`).join(', ')}`,
        { algorithm: 'xz' }
      );
    }

    const dictionarySize = decodeDictionarySize(dictProp);
    if (BigInt(dictionarySize) > this.options.maxDictionaryBytes) {
      throw new CompressionError(
        'COMPRESSION_XZ_LIMIT_EXCEEDED',
        `XZ dictionary size ${dictionarySize} exceeds limit`,
        { algorithm: 'xz' }
      );
    }

    const expectedCompressed =
      compressedSizeValue !== undefined ? toNumberOrThrow(compressedSizeValue, 'Compressed size') : undefined;
    const expectedUncompressed = uncompressedSizeValue;

    const check = createCheck(this.checkType, this.skipCheck);
    this.output.setCheck(check);
    const blockOutputStart = this.output.totalOut;
    const lzma2 = new Lzma2Decoder(dictionarySize, this.output, this.options.signal);
    const blockStart = this.reader.position;
    if (expectedCompressed !== undefined && expectedCompressed <= 0) {
      throw xzBadData('Invalid XZ block compressed size');
    }
    if (expectedCompressed !== undefined && blockStart + expectedCompressed > this.input.length) {
      throw xzBadData('Truncated XZ block data');
    }
    const limit = expectedCompressed !== undefined ? blockStart + expectedCompressed : this.input.length;
    const consumed = lzma2.decode(this.input, blockStart, limit);
    this.reader.position = blockStart + consumed;

    if (expectedCompressed !== undefined && consumed !== expectedCompressed) {
      throw xzBadData('XZ block compressed size mismatch');
    }

    const actualUncompressed = this.output.totalOut - blockOutputStart;
    if (expectedUncompressed !== undefined && actualUncompressed !== expectedUncompressed) {
      throw xzBadData('XZ block uncompressed size mismatch');
    }

    const padding = (4 - (consumed % 4)) & 3;
    if (padding > 0) {
      const pad = this.reader.readBytes(padding);
      for (const byte of pad) {
        if (byte !== 0x00) throw xzBadData('Non-zero bytes in XZ block padding');
      }
    }

    this.output.flush();
    if (this.checkSize > 0) {
      const stored = this.reader.readBytes(this.checkSize);
      if (!this.skipCheck) {
        const computed = check?.digestBytes() ?? new Uint8Array();
        if (!matches(stored, computed)) {
          throw new CompressionError('COMPRESSION_XZ_CHECK_MISMATCH', 'XZ check mismatch', { algorithm: 'xz' });
        }
      }
    }
    this.output.clearCheck();

    const unpaddedSize = BigInt(headerSize + consumed + this.checkSize);
    this.blocks.push({ unpaddedSize, uncompressedSize: actualUncompressed });
  }

  private decodeIndex(): number {
    const indexStart = this.reader.position;
    const indicator = this.reader.readByte();
    if (indicator !== 0x00) {
      throw xzBadData('Missing XZ index indicator');
    }
    const records = this.reader.readVli();
    const recordCount = toNumberOrThrow(records, 'Index record count');
    if (recordCount !== this.blocks.length) {
      throw xzBadData('XZ index record count mismatch');
    }
    for (let i = 0; i < recordCount; i += 1) {
      const unpadded = this.reader.readVli();
      const uncompressed = this.reader.readVli();
      const expected = this.blocks[i]!;
      if (unpadded !== expected.unpaddedSize || uncompressed !== expected.uncompressedSize) {
        throw xzBadData('XZ index entries do not match decoded blocks');
      }
    }

    const indexContentEnd = this.reader.position;
    const padding = (4 - ((indexContentEnd - indexStart) % 4)) & 3;
    if (padding > 0) {
      const pad = this.reader.readBytes(padding);
      for (const byte of pad) {
        if (byte !== 0x00) throw xzBadData('Non-zero bytes in XZ index padding');
      }
    }
    const storedCrc = this.reader.readUint32LE();
    const indexEnd = this.reader.position;
    const crc = new Crc32();
    crc.update(this.input.subarray(indexStart, indexEnd - 4));
    if (crc.digest() !== storedCrc) {
      throw xzBadData('XZ index CRC mismatch');
    }
    return indexEnd - indexStart;
  }

  private decodeFooter(indexSize: number): void {
    if (this.reader.remaining() < 12) {
      throw xzBadData('Truncated XZ stream footer');
    }
    const footerStart = this.reader.position;
    const storedCrc = this.reader.readUint32LE();
    const backwardSize = this.reader.readUint32LE();
    const flags = this.reader.readBytes(2);
    const magic = this.reader.readBytes(2);
    if (!matches(magic, FOOTER_MAGIC)) {
      throw xzBadData('Invalid XZ footer magic');
    }
    if (!matches(flags, this.streamFlags)) {
      throw xzBadData('XZ stream footer flags mismatch');
    }
    const crc = new Crc32();
    crc.update(this.input.subarray(footerStart + 4, footerStart + 10));
    if (crc.digest() !== storedCrc) {
      throw xzBadData('XZ stream footer CRC mismatch');
    }
    const realBackwardSize = (backwardSize + 1) * 4;
    if (realBackwardSize !== indexSize) {
      throw xzBadData('XZ backward size mismatch');
    }
  }

  private verifyStreamPadding(): void {
    if (this.reader.remaining() === 0) return;
    const padding = this.reader.readBytes(this.reader.remaining());
    for (const byte of padding) {
      if (byte !== 0x00) {
        throw xzBadData('Non-zero bytes found after XZ stream');
      }
    }
  }
}

class Lzma2Decoder {
  private needDictionaryReset = true;
  private needProperties = true;
  private readonly dict: Dictionary;
  private readonly lzma: LzmaDecoder;

  constructor(dictionarySize: number, output: OutputSink, signal?: AbortSignal) {
    this.dict = new Dictionary(dictionarySize, output, signal);
    this.lzma = new LzmaDecoder(this.dict, signal);
  }

  decode(input: Uint8Array, start: number, limit: number): number {
    let offset = start;
    while (true) {
      if (offset >= limit) {
        throw lzmaBadData('Truncated LZMA2 data');
      }
      const control = input[offset++]!;
      if (control === 0x00) break;

      if (control >= 0xe0 || control === 0x01) {
        this.needProperties = true;
        this.needDictionaryReset = true;
      } else if (this.needDictionaryReset) {
        throw lzmaBadData('LZMA2 dictionary reset missing');
      }

      if (control >= 0x80) {
        if (offset + 4 > limit) throw lzmaBadData('Truncated LZMA2 chunk header');
        const uncompressedSize = (((control & 0x1f) << 16) | (input[offset++]! << 8) | input[offset++]!) + 1;
        const compressedSize = ((input[offset++]! << 8) | input[offset++]!) + 1;
        if (compressedSize <= 0) throw lzmaBadData('Invalid LZMA2 compressed size');
        if (control >= 0xc0) {
          if (offset >= limit) throw lzmaBadData('Missing LZMA2 properties byte');
          const props = input[offset++]!;
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

        if (offset + compressedSize > limit) {
          throw lzmaBadData('Truncated LZMA2 compressed data');
        }
        const range = new RangeDecoder(input, offset, compressedSize);
        this.lzma.decode(range, uncompressedSize);
        if (range.position !== range.limit) {
          throw lzmaBadData('LZMA2 chunk has unused compressed bytes');
        }
        offset = range.position;
      } else {
        if (control > 0x02) throw lzmaBadData('Invalid LZMA2 control byte');
        if (offset + 2 > limit) throw lzmaBadData('Truncated LZMA2 uncompressed size');
        const size = ((input[offset++]! << 8) | input[offset++]!) + 1;
        if (this.needDictionaryReset) {
          this.dict.reset();
          this.needDictionaryReset = false;
        }
        if (offset + size > limit) {
          throw lzmaBadData('Truncated LZMA2 uncompressed data');
        }
        this.dict.copyUncompressed(input.subarray(offset, offset + size));
        offset += size;
      }
    }
    return offset - start;
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
    private readonly output: OutputSink,
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
    private readonly options: ResolvedOptions
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
    this.ensureLimits();
    if (this.length >= this.buffer.length) this.flush();
  }

  flush(): void {
    if (this.length === 0) return;
    const chunk = this.buffer.subarray(0, this.length);
    this.check?.update(chunk);
    this.emit(chunk);
    this.length = 0;
  }

  private ensureLimits(): void {
    if (this.options.maxOutputBytes !== undefined && this.bytesOut > this.options.maxOutputBytes) {
      throw new CompressionError('COMPRESSION_XZ_LIMIT_EXCEEDED', 'XZ output exceeds maxOutputBytes', {
        algorithm: 'xz'
      });
    }
    if (this.options.maxRatioBytes !== undefined && this.bytesOut > this.options.maxRatioBytes) {
      throw new CompressionError('COMPRESSION_XZ_LIMIT_EXCEEDED', 'XZ output exceeds maxCompressionRatio', {
        algorithm: 'xz'
      });
    }
    if (this.options.signal && (this.bytesOut & 0x3fffn) === 0n) {
      throwIfAborted(this.options.signal);
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

class ByteReader {
  constructor(private readonly buffer: Uint8Array, private offset = 0) {}

  get position(): number {
    return this.offset;
  }

  set position(value: number) {
    this.offset = value;
  }

  remaining(): number {
    return this.buffer.length - this.offset;
  }

  peekByte(): number {
    if (this.offset >= this.buffer.length) throw xzBadData('Unexpected end of XZ stream');
    return this.buffer[this.offset]!;
  }

  readByte(): number {
    if (this.offset >= this.buffer.length) throw xzBadData('Unexpected end of XZ stream');
    return this.buffer[this.offset++]!;
  }

  readBytes(length: number): Uint8Array {
    if (this.offset + length > this.buffer.length) throw xzBadData('Unexpected end of XZ stream');
    const out = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  readUint32LE(): number {
    if (this.offset + 4 > this.buffer.length) throw xzBadData('Unexpected end of XZ stream');
    const value = readUint32LE(this.buffer, this.offset);
    this.offset += 4;
    return value;
  }

  readVli(): bigint {
    let value = 0n;
    let shift = 0n;
    for (let i = 0; i < 9; i += 1) {
      const byte = this.readByte();
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        if (value > MAX_VLI) throw xzBadData('XZ VLI exceeds 63 bits');
        return value;
      }
      shift += 7n;
    }
    throw xzBadData('XZ VLI is too long');
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
  if (profile === 'agent') return BigInt(AGENT_MAX_DICTIONARY);
  return BigInt(DEFAULT_MAX_DICTIONARY);
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
  return id === 0x00 || id === 0x01 || id === 0x04;
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

function lzmaBadData(message: string): CompressionError {
  return new CompressionError('COMPRESSION_LZMA_BAD_DATA', message, { algorithm: 'xz' });
}
