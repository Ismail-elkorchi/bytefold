import { readUint16LE, readUint32LE, readUint64LE, writeUint16LE, writeUint32LE, writeUint64LE } from './binary.js';

export interface Zip64ExtraValues {
  uncompressedSize?: bigint;
  compressedSize?: bigint;
  offset?: bigint;
  diskStart?: number;
}

export interface ExtendedTimestampValues {
  mtime?: Date;
  atime?: Date;
  ctime?: Date;
}

export interface AesExtraValues {
  vendorVersion: 1 | 2;
  strength: 128 | 192 | 256;
  actualMethod: number;
}

export function parseExtraFields(extra: Uint8Array): Map<number, Uint8Array> {
  const map = new Map<number, Uint8Array>();
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const headerId = readUint16LE(extra, offset);
    const size = readUint16LE(extra, offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + size;
    if (dataEnd > extra.length) {
      break;
    }
    map.set(headerId, extra.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }
  return map;
}

export function parseZip64Extra(
  data: Uint8Array,
  present: {
    uncompressed: boolean;
    compressed: boolean;
    offset: boolean;
    diskStart: boolean;
  }
): Zip64ExtraValues {
  // APPNOTE 6.3.10 section 4.5.3: Zip64 extra fields appear in fixed order.
  let offset = 0;
  const values: Zip64ExtraValues = {};
  if (present.uncompressed) {
    values.uncompressedSize = readUint64LE(data, offset);
    offset += 8;
  }
  if (present.compressed) {
    values.compressedSize = readUint64LE(data, offset);
    offset += 8;
  }
  if (present.offset) {
    values.offset = readUint64LE(data, offset);
    offset += 8;
  }
  if (present.diskStart) {
    values.diskStart = readUint32LE(data, offset);
    offset += 4;
  }
  return values;
}

export function buildZip64Extra(values: Zip64ExtraValues): Uint8Array {
  const parts: Uint8Array[] = [];
  let size = 0;
  if (values.uncompressedSize !== undefined) size += 8;
  if (values.compressedSize !== undefined) size += 8;
  if (values.offset !== undefined) size += 8;
  if (values.diskStart !== undefined) size += 4;

  const header = new Uint8Array(4 + size);
  writeUint16LE(header, 0, 0x0001);
  writeUint16LE(header, 2, size);
  let offset = 4;
  if (values.uncompressedSize !== undefined) {
    writeUint64LE(header, offset, values.uncompressedSize);
    offset += 8;
  }
  if (values.compressedSize !== undefined) {
    writeUint64LE(header, offset, values.compressedSize);
    offset += 8;
  }
  if (values.offset !== undefined) {
    writeUint64LE(header, offset, values.offset);
    offset += 8;
  }
  if (values.diskStart !== undefined) {
    writeUint32LE(header, offset, values.diskStart);
    offset += 4;
  }
  parts.push(header);
  return concat(parts);
}

export function parseExtendedTimestamp(data: Uint8Array): ExtendedTimestampValues {
  if (data.length === 0) return {};
  let offset = 0;
  const flags = data[offset]!;
  offset += 1;
  const values: ExtendedTimestampValues = {};
  if (flags & 0x01) {
    values.mtime = new Date(readUint32LE(data, offset) * 1000);
    offset += 4;
  }
  if (flags & 0x02) {
    values.atime = new Date(readUint32LE(data, offset) * 1000);
    offset += 4;
  }
  if (flags & 0x04) {
    values.ctime = new Date(readUint32LE(data, offset) * 1000);
    offset += 4;
  }
  return values;
}

export function buildExtendedTimestampExtra(values: ExtendedTimestampValues, isCentral: boolean): Uint8Array {
  // appnote_iz.txt: extended timestamp extra field (0x5455) layout.
  const hasMtime = values.mtime instanceof Date;
  const hasAtime = !isCentral && values.atime instanceof Date;
  const hasCtime = !isCentral && values.ctime instanceof Date;
  if (!hasMtime && !hasAtime && !hasCtime) return new Uint8Array(0);

  let dataSize = 1; // flags
  if (hasMtime) dataSize += 4;
  if (hasAtime) dataSize += 4;
  if (hasCtime) dataSize += 4;

  const out = new Uint8Array(4 + dataSize);
  writeUint16LE(out, 0, 0x5455);
  writeUint16LE(out, 2, dataSize);
  let offset = 4;
  let flags = 0;
  if (hasMtime) flags |= 0x01;
  if (hasAtime) flags |= 0x02;
  if (hasCtime) flags |= 0x04;
  out[offset] = flags;
  offset += 1;
  if (hasMtime) {
    writeUint32LE(out, offset, Math.floor(values.mtime!.getTime() / 1000));
    offset += 4;
  }
  if (hasAtime) {
    writeUint32LE(out, offset, Math.floor(values.atime!.getTime() / 1000));
    offset += 4;
  }
  if (hasCtime) {
    writeUint32LE(out, offset, Math.floor(values.ctime!.getTime() / 1000));
    offset += 4;
  }
  return out;
}

export function buildAesExtra(values: AesExtraValues): Uint8Array {
  const out = new Uint8Array(4 + 7);
  writeUint16LE(out, 0, 0x9901);
  writeUint16LE(out, 2, 7);
  writeUint16LE(out, 4, values.vendorVersion);
  out[6] = 0x41; // 'A'
  out[7] = 0x45; // 'E'
  out[8] = strengthToCode(values.strength);
  writeUint16LE(out, 9, values.actualMethod);
  return out;
}

export function parseAesExtra(data: Uint8Array): AesExtraValues | undefined {
  if (data.length < 7) return undefined;
  const vendorVersion = readUint16LE(data, 0);
  if (vendorVersion !== 1 && vendorVersion !== 2) return undefined;
  if (data[2] !== 0x41 || data[3] !== 0x45) return undefined;
  const strength = codeToStrength(data[4]!);
  if (!strength) return undefined;
  const actualMethod = readUint16LE(data, 5);
  return {
    vendorVersion: vendorVersion as 1 | 2,
    strength,
    actualMethod
  };
}

function strengthToCode(strength: 128 | 192 | 256): 1 | 2 | 3 {
  switch (strength) {
    case 128:
      return 1;
    case 192:
      return 2;
    case 256:
      return 3;
    default: {
      const exhaustive: never = strength;
      return exhaustive;
    }
  }
}

function codeToStrength(code: number): 128 | 192 | 256 | undefined {
  switch (code) {
    case 1:
      return 128;
    case 2:
      return 192;
    case 3:
      return 256;
    default:
      return undefined;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
