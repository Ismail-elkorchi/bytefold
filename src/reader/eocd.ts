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
  comment: Uint8Array;
  warnings: ZipWarning[];
}

export async function findEocd(
  reader: RandomAccess,
  strict: boolean,
  signal?: AbortSignal
): Promise<EocdResult> {
  const warnings: ZipWarning[] = [];
  const size = await reader.size(signal);
  if (size < 22n) {
    throw new ZipError('ZIP_EOCD_NOT_FOUND', 'File too small for EOCD');
  }
  throwIfAborted(signal);
  // APPNOTE 6.3.10 section 4.3.16: EOCD is located within last 64KiB + minimum size.
  const maxSearch = 0x10000n + 22n; // 64KiB + EOCD
  const searchSize = size < maxSearch ? size : maxSearch;
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
  const commentLength = readUint16LE(buffer, chosenIndex + 20);
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
  const totalEntries = readUint16LE(buffer, chosenIndex + 10);
  const cdSize32 = readUint32LE(buffer, chosenIndex + 12);
  const cdOffset32 = readUint32LE(buffer, chosenIndex + 16);
  const comment = buffer.subarray(chosenIndex + 22, chosenIndex + 22 + commentLength);

  const needsZip64 =
    cdDisk === 0xffff ||
    totalEntries === 0xffff ||
    cdSize32 === 0xffffffff ||
    cdOffset32 === 0xffffffff;

  if (!needsZip64) {
    return {
      eocdOffset,
      cdOffset: BigInt(cdOffset32),
      cdSize: BigInt(cdSize32),
      totalEntries: BigInt(totalEntries),
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
  const totalEntries64 = readUint64LE(zip64Header, 32);
  const cdSize64 = readUint64LE(zip64Header, 40);
  const cdOffset64 = readUint64LE(zip64Header, 48);

  return {
    eocdOffset,
    cdOffset: cdOffset64,
    cdSize: cdSize64,
    totalEntries: totalEntries64,
    comment,
    warnings
  };
}
