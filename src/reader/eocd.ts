import { readUint16LE, readUint32LE, readUint64LE } from '../binary.js';
import { ZipError, ZipWarning } from '../errors.js';
import { throwIfAborted } from '../abort.js';
import type { RandomAccess } from './RandomAccess.js';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

export interface EocdResult {
  eocdOffset: bigint;
  cdOffset: bigint;
  cdSize: bigint;
  totalEntries: bigint;
  entriesOnDisk: bigint;
  diskNumber: number;
  cdDisk: number;
  comment: Uint8Array;
  warnings: ZipWarning[];
}

export interface FindEocdOptions {
  maxSearchBytes?: number;
  maxCommentBytes?: number;
  maxCentralDirectoryBytes?: number;
  maxEntries?: number;
  rejectMultiDisk?: boolean;
}

export async function findEocd(
  reader: RandomAccess,
  strict: boolean,
  signal?: AbortSignal,
  options?: FindEocdOptions
): Promise<EocdResult> {
  const warnings: ZipWarning[] = [];
  const size = await reader.size(signal);
  if (size < 22n) {
    throw new ZipError('ZIP_EOCD_NOT_FOUND', 'File too small for EOCD');
  }
  throwIfAborted(signal);
  // APPNOTE 6.3.10 section 4.3.16: EOCD is located within last 64KiB + minimum size.
  const maxSearch = 0x10000n + 22n; // 64KiB + EOCD
  const requiredSearch = size < maxSearch ? size : maxSearch;
  const searchLimitRaw = options?.maxSearchBytes;
  const searchLimit =
    typeof searchLimitRaw === 'number' && Number.isFinite(searchLimitRaw)
      ? Math.max(22, Math.floor(searchLimitRaw))
      : undefined;
  if (searchLimit !== undefined && BigInt(searchLimit) < requiredSearch) {
    throw new ZipError('ZIP_LIMIT_EXCEEDED', 'EOCD search window exceeds limit', {
      context: {
        requiredSearchBytes: requiredSearch.toString(),
        limitSearchBytes: String(searchLimit)
      }
    });
  }
  const searchSize =
    searchLimit !== undefined ? minBigInt(requiredSearch, BigInt(searchLimit)) : requiredSearch;
  const searchStart = size - searchSize;
  const buffer = await reader.read(searchStart, Number(searchSize), signal);

  const candidates: number[] = [];
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    throwIfAborted(signal);
    if (readUint32LE(buffer, i) === EOCD_SIGNATURE) {
      candidates.push(i);
    }
  }

  if (candidates.length === 0) {
    throw new ZipError('ZIP_EOCD_NOT_FOUND', 'End of central directory not found');
  }

  if (candidates.length > 1) {
    if (strict) {
      throw new ZipError('ZIP_MULTIPLE_EOCD', 'Multiple EOCD records found');
    }
    warnings.push({
      code: 'ZIP_MULTIPLE_EOCD',
      message: 'Multiple EOCD records found; using last occurrence'
    });
  }

  const chosenIndex = candidates[0]!; // last match in search window
  const eocdOffset = searchStart + BigInt(chosenIndex);
  const diskNumber = readUint16LE(buffer, chosenIndex + 4);
  const commentLength = readUint16LE(buffer, chosenIndex + 20);
  const maxCommentRaw = options?.maxCommentBytes;
  const maxCommentBytes =
    typeof maxCommentRaw === 'number' && Number.isFinite(maxCommentRaw)
      ? Math.max(0, Math.floor(maxCommentRaw))
      : undefined;
  if (maxCommentBytes !== undefined && commentLength > maxCommentBytes) {
    throw new ZipError('ZIP_LIMIT_EXCEEDED', 'ZIP comment exceeds limit', {
      context: {
        requiredCommentBytes: String(commentLength),
        limitCommentBytes: String(maxCommentBytes)
      }
    });
  }
  const recordEnd = BigInt(chosenIndex + 22 + commentLength);
  if (searchStart + recordEnd !== size) {
    if (strict) {
      throw new ZipError('ZIP_BAD_EOCD', 'EOCD does not end at EOF');
    }
    warnings.push({
      code: 'ZIP_BAD_EOCD',
      message: 'EOCD does not end at EOF; continuing in non-strict mode'
    });
  }

  const cdDisk = readUint16LE(buffer, chosenIndex + 6);
  const entriesOnDisk = readUint16LE(buffer, chosenIndex + 8);
  const totalEntries = readUint16LE(buffer, chosenIndex + 10);
  const cdSize32 = readUint32LE(buffer, chosenIndex + 12);
  const cdOffset32 = readUint32LE(buffer, chosenIndex + 16);
  const comment = buffer.subarray(chosenIndex + 22, chosenIndex + 22 + commentLength);

  const needsZip64 =
    cdDisk === 0xffff ||
    totalEntries === 0xffff ||
    cdSize32 === 0xffffffff ||
    cdOffset32 === 0xffffffff;

  const maxCdRaw = options?.maxCentralDirectoryBytes;
  const maxCdBytes =
    typeof maxCdRaw === 'number' && Number.isFinite(maxCdRaw) ? Math.max(0, Math.floor(maxCdRaw)) : undefined;
  const maxEntriesRaw = options?.maxEntries;
  const maxEntries =
    typeof maxEntriesRaw === 'number' && Number.isFinite(maxEntriesRaw) ? Math.max(0, Math.floor(maxEntriesRaw)) : undefined;

  const limitOptions: { maxCdBytes?: number; maxEntries?: number; rejectMultiDisk?: boolean } = {};
  if (maxCdBytes !== undefined) limitOptions.maxCdBytes = maxCdBytes;
  if (maxEntries !== undefined) limitOptions.maxEntries = maxEntries;
  if (typeof options?.rejectMultiDisk === 'boolean') limitOptions.rejectMultiDisk = options.rejectMultiDisk;

  if (!needsZip64) {
    const cdSize = BigInt(cdSize32);
    const totalEntriesBig = BigInt(totalEntries);
    const entriesOnDiskBig = BigInt(entriesOnDisk);
    enforceZipLimits({ cdSize, totalEntries: totalEntriesBig, entriesOnDisk: entriesOnDiskBig, diskNumber, cdDisk }, limitOptions);
    return {
      eocdOffset,
      cdOffset: BigInt(cdOffset32),
      cdSize,
      totalEntries: totalEntriesBig,
      entriesOnDisk: entriesOnDiskBig,
      diskNumber,
      cdDisk,
      comment,
      warnings
    };
  }

  const locatorOffset = eocdOffset - 20n;
  if (locatorOffset < 0n) {
    throw new ZipError('ZIP_BAD_ZIP64', 'Missing ZIP64 locator');
  }
  const locator = await reader.read(locatorOffset, 20, signal);
  if (locator.length < 20 || readUint32LE(locator, 0) !== ZIP64_LOCATOR_SIGNATURE) {
    throw new ZipError('ZIP_BAD_ZIP64', 'ZIP64 locator signature missing');
  }
  const zip64EocdOffset = readUint64LE(locator, 8);
  const zip64Header = await reader.read(zip64EocdOffset, 56, signal);
  if (zip64Header.length < 56 || readUint32LE(zip64Header, 0) !== ZIP64_EOCD_SIGNATURE) {
    throw new ZipError('ZIP_BAD_ZIP64', 'ZIP64 EOCD signature missing');
  }
  const diskNumber64 = readUint32LE(zip64Header, 16);
  const cdDisk64 = readUint32LE(zip64Header, 20);
  const entriesOnDisk64 = readUint64LE(zip64Header, 24);
  const totalEntries64 = readUint64LE(zip64Header, 32);
  const cdSize64 = readUint64LE(zip64Header, 40);
  const cdOffset64 = readUint64LE(zip64Header, 48);

  enforceZipLimits(
    {
      cdSize: cdSize64,
      totalEntries: totalEntries64,
      entriesOnDisk: entriesOnDisk64,
      diskNumber: diskNumber64,
      cdDisk: cdDisk64
    },
    limitOptions
  );

  return {
    eocdOffset,
    cdOffset: cdOffset64,
    cdSize: cdSize64,
    totalEntries: totalEntries64,
    entriesOnDisk: entriesOnDisk64,
    diskNumber: diskNumber64,
    cdDisk: cdDisk64,
    comment,
    warnings
  };
}

function enforceZipLimits(
  info: {
    cdSize: bigint;
    totalEntries: bigint;
    entriesOnDisk: bigint;
    diskNumber: number;
    cdDisk: number;
  },
  limits: { maxCdBytes?: number; maxEntries?: number; rejectMultiDisk?: boolean | undefined }
): void {
  if (limits.maxCdBytes !== undefined && info.cdSize > BigInt(limits.maxCdBytes)) {
    throw new ZipError('ZIP_LIMIT_EXCEEDED', 'Central directory size exceeds limit', {
      context: {
        requiredCentralDirectoryBytes: info.cdSize.toString(),
        limitCentralDirectoryBytes: String(limits.maxCdBytes)
      }
    });
  }
  if (limits.maxEntries !== undefined && info.totalEntries > BigInt(limits.maxEntries)) {
    throw new ZipError('ZIP_LIMIT_EXCEEDED', 'Entry count exceeds limit', {
      context: {
        requiredEntries: info.totalEntries.toString(),
        limitEntries: String(limits.maxEntries)
      }
    });
  }
  if (limits.rejectMultiDisk && (info.diskNumber !== 0 || info.cdDisk !== 0 || info.entriesOnDisk !== info.totalEntries)) {
    throw new ZipError('ZIP_UNSUPPORTED_FEATURE', 'Multi-disk ZIP archives are not supported', {
      context: {
        diskNumber: String(info.diskNumber),
        cdDisk: String(info.cdDisk),
        entriesOnDisk: info.entriesOnDisk.toString(),
        totalEntries: info.totalEntries.toString()
      }
    });
  }
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
