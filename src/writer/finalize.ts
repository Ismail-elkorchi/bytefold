import { encodeUtf8, writeUint16LE, writeUint32LE, writeUint64LE } from '../binary.js';
import type { Sink } from './Sink.js';

const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD_SIGNATURE = 0x06054b50;

export interface FinalizeOptions {
  entryCount: bigint;
  cdOffset: bigint;
  cdSize: bigint;
  forceZip64: boolean;
  hasZip64Entries: boolean;
  comment?: string | undefined;
}

export async function finalizeArchive(sink: Sink, options: FinalizeOptions): Promise<void> {
  const needsZip64 =
    options.forceZip64 ||
    options.hasZip64Entries ||
    options.entryCount > 0xffffn ||
    options.cdOffset > 0xffffffffn ||
    options.cdSize > 0xffffffffn;

  if (needsZip64) {
    const zip64Offset = sink.position;
    const record = new Uint8Array(56);
    writeUint32LE(record, 0, ZIP64_EOCD_SIGNATURE);
    writeUint64LE(record, 4, 44n); // size of remaining record
    writeUint16LE(record, 12, 45); // version made by
    writeUint16LE(record, 14, 45); // version needed
    writeUint32LE(record, 16, 0);
    writeUint32LE(record, 20, 0);
    writeUint64LE(record, 24, options.entryCount);
    writeUint64LE(record, 32, options.entryCount);
    writeUint64LE(record, 40, options.cdSize);
    writeUint64LE(record, 48, options.cdOffset);
    await sink.write(record);

    const locator = new Uint8Array(20);
    writeUint32LE(locator, 0, ZIP64_LOCATOR_SIGNATURE);
    writeUint32LE(locator, 4, 0);
    writeUint64LE(locator, 8, zip64Offset);
    writeUint32LE(locator, 16, 1);
    await sink.write(locator);
  }

  const commentBytes = options.comment ? encodeUtf8(options.comment) : new Uint8Array(0);
  const eocd = new Uint8Array(22 + commentBytes.length);
  writeUint32LE(eocd, 0, EOCD_SIGNATURE);
  writeUint16LE(eocd, 4, 0);
  writeUint16LE(eocd, 6, 0);

  if (needsZip64) {
    writeUint16LE(eocd, 8, 0xffff);
    writeUint16LE(eocd, 10, 0xffff);
    writeUint32LE(eocd, 12, 0xffffffff);
    writeUint32LE(eocd, 16, 0xffffffff);
  } else {
    writeUint16LE(eocd, 8, Number(options.entryCount));
    writeUint16LE(eocd, 10, Number(options.entryCount));
    writeUint32LE(eocd, 12, Number(options.cdSize));
    writeUint32LE(eocd, 16, Number(options.cdOffset));
  }

  writeUint16LE(eocd, 20, commentBytes.length);
  eocd.set(commentBytes, 22);
  await sink.write(eocd);
}
