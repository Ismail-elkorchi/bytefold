import { decodeUtf8, readUint16LE, readUint32LE } from '../binary.js';
import { Crc32 } from '../crc32.js';
import { decodeCp437 } from '../cp437.js';
import { dosToDate } from '../dosTime.js';
import { parseExtendedTimestamp, parseExtraFields, parseZip64Extra } from '../extraFields.js';
import { ZipError, type ZipWarning } from '../errors.js';
import type { RandomAccess } from './RandomAccess.js';

const CDFH_SIGNATURE = 0x02014b50;
const CDFH_MIN_SIZE = 46;

export interface ZipEntryRecord {
  name: string;
  nameSource: 'utf8-flag' | 'cp437' | 'unicode-extra';
  rawNameBytes: Uint8Array;
  comment?: string | undefined;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: bigint;
  uncompressedSize: bigint;
  offset: bigint;
  mtime: Date;
  atime?: Date | undefined;
  ctime?: Date | undefined;
  extra: Map<number, Uint8Array>;
  extraLength: number;
  isDirectory: boolean;
  isSymlink: boolean;
  encrypted: boolean;
  madeBy: number;
  externalAttributes: number;
  zip64: boolean;
}

export interface CentralDirectoryResult {
  entries: ZipEntryRecord[];
  warnings: ZipWarning[];
}

export interface CentralDirectoryOptions {
  strict: boolean;
  maxEntries: number;
}

export interface CentralDirectoryStreamOptions extends CentralDirectoryOptions {
  signal?: AbortSignal;
  onWarning?: (warning: ZipWarning) => void;
}

export async function readCentralDirectory(
  reader: RandomAccess,
  cdOffset: bigint,
  cdSize: bigint,
  totalEntries: bigint,
  options: CentralDirectoryOptions
): Promise<CentralDirectoryResult> {
  const entries: ZipEntryRecord[] = [];
  const warnings: ZipWarning[] = [];

  for await (const entry of iterCentralDirectory(reader, cdOffset, cdSize, totalEntries, {
    ...options,
    onWarning: (warning) => warnings.push(warning)
  })) {
    entries.push(entry);
  }

  return { entries, warnings };
}

export async function* iterCentralDirectory(
  reader: RandomAccess,
  cdOffset: bigint,
  cdSize: bigint,
  totalEntries: bigint,
  options: CentralDirectoryStreamOptions
): AsyncGenerator<ZipEntryRecord> {
  const warnings: ZipWarning[] = [];
  const pushWarning = (warning: ZipWarning) => {
    warnings.push(warning);
    options.onWarning?.(warning);
  };

  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let ptr = 0;
  let remainingToRead = cdSize;
  let remainingCd = cdSize;
  let position = cdOffset;
  let count = 0n;

  const ensure = async (minBytes: number): Promise<void> => {
    while (buffer.length - ptr < minBytes && remainingToRead > 0n) {
      options.signal?.throwIfAborted();
      const chunkSize = 64 * 1024;
      const toRead = Number(remainingToRead > BigInt(chunkSize) ? chunkSize : remainingToRead);
      if (toRead <= 0) break;
      const chunk = await reader.read(position, toRead, options.signal);
      if (chunk.length === 0) break;
      position += BigInt(chunk.length);
      remainingToRead -= BigInt(chunk.length);
      if (ptr === 0 && buffer.length === 0) {
        buffer = chunk;
      } else {
        const leftover = buffer.subarray(ptr);
        const merged = new Uint8Array(leftover.length + chunk.length);
        merged.set(leftover, 0);
        merged.set(chunk, leftover.length);
        buffer = merged;
        ptr = 0;
      }
    }
  };

  while (remainingCd > 0n) {
    if (remainingCd < BigInt(CDFH_MIN_SIZE)) {
      break;
    }
    await ensure(CDFH_MIN_SIZE);
    if (buffer.length - ptr < CDFH_MIN_SIZE) {
      throw new ZipError('ZIP_TRUNCATED', 'Central directory truncated');
    }
    const signature = readUint32LE(buffer, ptr);
    if (signature !== CDFH_SIGNATURE) {
      throw new ZipError('ZIP_BAD_CENTRAL_DIRECTORY', 'Invalid central directory signature');
    }

    const nameLen = readUint16LE(buffer, ptr + 28);
    const extraLen = readUint16LE(buffer, ptr + 30);
    const commentLen = readUint16LE(buffer, ptr + 32);
    const entrySize = CDFH_MIN_SIZE + nameLen + extraLen + commentLen;
    if (BigInt(entrySize) > remainingCd) {
      throw new ZipError('ZIP_TRUNCATED', 'Central directory truncated');
    }

    await ensure(entrySize);
    if (buffer.length - ptr < entrySize) {
      throw new ZipError('ZIP_TRUNCATED', 'Central directory truncated');
    }

    const parsed = parseCentralDirectoryEntry(buffer, ptr, options, pushWarning);
    yield parsed.entry;
    count += 1n;
    if (count > BigInt(options.maxEntries)) {
      throw new ZipError('ZIP_LIMIT_EXCEEDED', 'Too many entries in ZIP');
    }

    ptr += entrySize;
    remainingCd -= BigInt(entrySize);
  }

  if (remainingCd !== 0n) {
    if (options.strict) {
      throw new ZipError('ZIP_BAD_CENTRAL_DIRECTORY', 'Central directory has trailing data');
    }
    pushWarning({
      code: 'ZIP_BAD_CENTRAL_DIRECTORY',
      message: 'Central directory has trailing data; ignoring'
    });
  }

  if (totalEntries !== 0n && totalEntries !== count) {
    if (options.strict) {
      throw new ZipError('ZIP_BAD_CENTRAL_DIRECTORY', 'Central directory entry count mismatch');
    }
    pushWarning({
      code: 'ZIP_BAD_CENTRAL_DIRECTORY',
      message: 'Central directory entry count mismatch; using parsed entries'
    });
  }
}

function parseCentralDirectoryEntry(
  buffer: Uint8Array,
  ptr: number,
  options: CentralDirectoryOptions,
  pushWarning: (warning: ZipWarning) => void
): { entry: ZipEntryRecord; size: number } {
  const madeBy = readUint16LE(buffer, ptr + 4);
  const flags = readUint16LE(buffer, ptr + 8);
  const method = readUint16LE(buffer, ptr + 10);
  const modTime = readUint16LE(buffer, ptr + 12);
  const modDate = readUint16LE(buffer, ptr + 14);
  const crc32 = readUint32LE(buffer, ptr + 16);
  const compressedSize32 = readUint32LE(buffer, ptr + 20);
  const uncompressedSize32 = readUint32LE(buffer, ptr + 24);
  const nameLen = readUint16LE(buffer, ptr + 28);
  const extraLen = readUint16LE(buffer, ptr + 30);
  const commentLen = readUint16LE(buffer, ptr + 32);
  const diskStart = readUint16LE(buffer, ptr + 34);
  const externalAttributes = readUint32LE(buffer, ptr + 38);
  const offset32 = readUint32LE(buffer, ptr + 42);

  const nameStart = ptr + CDFH_MIN_SIZE;
  const nameEnd = nameStart + nameLen;
  const extraStart = nameEnd;
  const extraEnd = extraStart + extraLen;
  const commentStart = extraEnd;
  const commentEnd = commentStart + commentLen;

  if (commentEnd > buffer.length) {
    throw new ZipError('ZIP_TRUNCATED', 'Central directory truncated');
  }

  const nameBytes = buffer.subarray(nameStart, nameEnd);
  const extraBytes = buffer.subarray(extraStart, extraEnd);
  const commentBytes = buffer.subarray(commentStart, commentEnd);
  let name: string;
  let nameSource: 'utf8-flag' | 'cp437' | 'unicode-extra' = 'cp437';
  if (flags & 0x800) {
    try {
      name = decodeUtf8(nameBytes, true);
      nameSource = 'utf8-flag';
    } catch (err) {
      if (options.strict) {
        throw new ZipError('ZIP_INVALID_ENCODING', 'Invalid UTF-8 filename', { cause: err });
      }
      pushWarning({
        code: 'ZIP_INVALID_ENCODING',
        message: 'Invalid UTF-8 filename; using replacement characters'
      });
      name = decodeUtf8(nameBytes, false);
      nameSource = 'utf8-flag';
    }
  } else {
    name = decodeCp437(nameBytes);
    nameSource = 'cp437';
  }

  let comment: string | undefined;
  if (commentBytes.length > 0) {
    if (flags & 0x800) {
      comment = decodeUtf8(commentBytes, false);
    } else {
      comment = decodeCp437(commentBytes);
    }
  }

  const extra = parseExtraFields(extraBytes);
  const zip64Extra = extra.get(0x0001);

  if ((flags & 0x800) === 0) {
    const unicodeName = parseUnicodeExtraField(
      extra.get(0x7075),
      nameBytes,
      options.strict,
      pushWarning,
      'path'
    );
    if (unicodeName !== undefined) {
      name = unicodeName;
      nameSource = 'unicode-extra';
    }
    const unicodeComment = parseUnicodeExtraField(
      extra.get(0x6375),
      commentBytes,
      options.strict,
      pushWarning,
      'comment'
    );
    if (unicodeComment !== undefined) {
      comment = unicodeComment;
    }
  }

  const needsZip64 =
    compressedSize32 === 0xffffffff ||
    uncompressedSize32 === 0xffffffff ||
    offset32 === 0xffffffff ||
    diskStart === 0xffff;

  let compressedSize = BigInt(compressedSize32);
  let uncompressedSize = BigInt(uncompressedSize32);
  let offset = BigInt(offset32);
  let zip64 = false;

  if (needsZip64) {
    if (!zip64Extra) {
      throw new ZipError('ZIP_BAD_ZIP64', 'ZIP64 extra field missing');
    }
    const values = parseZip64Extra(zip64Extra, {
      uncompressed: uncompressedSize32 === 0xffffffff,
      compressed: compressedSize32 === 0xffffffff,
      offset: offset32 === 0xffffffff,
      diskStart: diskStart === 0xffff
    });
    if (values.uncompressedSize !== undefined) uncompressedSize = values.uncompressedSize;
    if (values.compressedSize !== undefined) compressedSize = values.compressedSize;
    if (values.offset !== undefined) offset = values.offset;
    if (values.diskStart !== undefined && values.diskStart !== 0) {
      throw new ZipError('ZIP_UNSUPPORTED_FEATURE', 'Multi-disk ZIP is not supported');
    }
    zip64 = true;
  }

  if (diskStart !== 0 && !needsZip64) {
    throw new ZipError('ZIP_UNSUPPORTED_FEATURE', 'Multi-disk ZIP is not supported');
  }

  let mtime = dosToDate(modTime, modDate);
  let atime: Date | undefined;
  let ctime: Date | undefined;
  const timestampExtra = extra.get(0x5455);
  if (timestampExtra) {
    const times = parseExtendedTimestamp(timestampExtra);
    if (times.mtime) mtime = times.mtime;
    if (times.atime) atime = times.atime;
    if (times.ctime) ctime = times.ctime;
  }

  const host = madeBy >>> 8;
  const unixMode = host === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
  const isSymlink = host === 3 && (unixMode & 0xf000) === 0xa000;
  const isDirectory = name.endsWith('/');
  const encrypted = (flags & 0x1) !== 0;

  const entry: ZipEntryRecord = {
    name,
    nameSource,
    rawNameBytes: nameBytes,
    comment,
    flags,
    method,
    crc32,
    compressedSize,
    uncompressedSize,
    offset,
    mtime,
    atime,
    ctime,
    extra,
    extraLength: extraBytes.length,
    isDirectory,
    isSymlink,
    encrypted,
    madeBy,
    externalAttributes,
    zip64
  };

  return { entry, size: commentEnd - ptr };
}

function parseUnicodeExtraField(
  data: Uint8Array | undefined,
  originalBytes: Uint8Array,
  strict: boolean,
  pushWarning: (warning: ZipWarning) => void,
  kind: 'path' | 'comment'
): string | undefined {
  if (!data) return undefined;
  // Info-ZIP Unicode Path/Comment extra fields (0x7075/0x6375), see specs/appnote_iz.txt.
  if (data.length < 5) {
    if (strict) {
      pushWarning({
        code: 'ZIP_UNSUPPORTED_FEATURE',
        message: `Malformed Unicode ${kind} extra field; ignoring`
      });
    }
    return undefined;
  }
  const version = data[0]!;
  if (version !== 1) {
    if (strict) {
      pushWarning({
        code: 'ZIP_UNSUPPORTED_FEATURE',
        message: `Unsupported Unicode ${kind} extra field version ${version}; ignoring`
      });
    }
    return undefined;
  }
  const expectedCrc = crc32Digest(originalBytes);
  const actualCrc = readUint32LE(data, 1);
  if (expectedCrc !== actualCrc) {
    return undefined;
  }
  const utf8Bytes = data.subarray(5);
  try {
    return decodeUtf8(utf8Bytes, true);
  } catch {
    if (strict) {
      pushWarning({
        code: 'ZIP_INVALID_ENCODING',
        message: `Invalid UTF-8 in Unicode ${kind} extra field; ignoring`
      });
    }
    return undefined;
  }
}

function crc32Digest(bytes: Uint8Array): number {
  const crc = new Crc32();
  crc.update(bytes);
  return crc.digest();
}
