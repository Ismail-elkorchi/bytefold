import { readUint16LE, readUint32LE } from '../binary.js';
import { ZipError } from '../errors.js';
import type { RandomAccess } from './RandomAccess.js';
import type { ZipEntryRecord } from './centralDirectory.js';

const LFH_SIGNATURE = 0x04034b50;

export interface LocalHeaderInfo {
  flags: number;
  method: number;
  modTime: number;
  modDate: number;
  nameLen: number;
  extraLen: number;
  nameBytes: Uint8Array;
  extra: Uint8Array;
  dataOffset: bigint;
}

export async function readLocalHeader(
  reader: RandomAccess,
  entry: ZipEntryRecord,
  signal?: AbortSignal
): Promise<LocalHeaderInfo> {
  const header = await reader.read(entry.offset, 30, signal);
  if (header.length < 30 || readUint32LE(header, 0) !== LFH_SIGNATURE) {
    throw new ZipError('ZIP_INVALID_SIGNATURE', 'Invalid local file header signature', {
      entryName: entry.name,
      offset: entry.offset
    });
  }
  const flags = readUint16LE(header, 6);
  const method = readUint16LE(header, 8);
  const modTime = readUint16LE(header, 10);
  const modDate = readUint16LE(header, 12);
  const nameLen = readUint16LE(header, 26);
  const extraLen = readUint16LE(header, 28);
  const nameAndExtra = await reader.read(entry.offset + 30n, nameLen + extraLen, signal);
  if (nameAndExtra.length < nameLen + extraLen) {
    throw new ZipError('ZIP_TRUNCATED', 'Local header truncated', { entryName: entry.name });
  }
  const nameBytes = nameAndExtra.subarray(0, nameLen);
  const extra = nameAndExtra.subarray(nameLen);
  const dataOffset = entry.offset + 30n + BigInt(nameLen + extraLen);
  return {
    flags,
    method,
    modTime,
    modDate,
    nameLen,
    extraLen,
    nameBytes,
    extra,
    dataOffset
  };
}
