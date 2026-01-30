import { encodeUtf8, writeUint16LE, writeUint32LE } from '../binary.js';
import { throwIfAborted } from '../abort.js';
import { dateToDos } from '../dosTime.js';
import { buildExtendedTimestampExtra, buildZip64Extra } from '../extraFields.js';
import type { EntryWriteResult } from './entryWriter.js';
import type { Sink } from './Sink.js';

const CDFH_SIGNATURE = 0x02014b50;

export interface CentralDirectoryInfo {
  offset: bigint;
  size: bigint;
}

export async function writeCentralDirectory(
  sink: Sink,
  entries: EntryWriteResult[],
  signal?: AbortSignal
): Promise<CentralDirectoryInfo> {
  const offset = sink.position;
  let size = 0n;

  for (const entry of entries) {
    throwIfAborted(signal);
    const nameBytes = entry.nameBytes;
    const commentBytes = entry.comment ? encodeUtf8(entry.comment) : new Uint8Array(0);
    const dos = dateToDos(entry.mtime);

    const needsZip64 =
      entry.zip64 ||
      entry.compressedSize > 0xffffffffn ||
      entry.uncompressedSize > 0xffffffffn ||
      entry.offset > 0xffffffffn;

    const zip64Extra = needsZip64
      ? buildZip64Extra({
          uncompressedSize: entry.uncompressedSize,
          compressedSize: entry.compressedSize,
          offset: entry.offset
        })
      : new Uint8Array(0);
    const timestampExtra = buildExtendedTimestampExtra({ mtime: entry.mtime }, true);
    const extra = concat([zip64Extra, entry.aesExtra ?? new Uint8Array(0), timestampExtra]);

    const header = new Uint8Array(46 + nameBytes.length + extra.length + commentBytes.length);
    writeUint32LE(header, 0, CDFH_SIGNATURE);
    const madeByVersion = entry.versionNeeded;
    writeUint16LE(header, 4, (3 << 8) | madeByVersion); // Unix
    writeUint16LE(header, 6, entry.versionNeeded);
    writeUint16LE(header, 8, entry.flags);
    writeUint16LE(header, 10, entry.method);
    writeUint16LE(header, 12, dos.time);
    writeUint16LE(header, 14, dos.date);
    writeUint32LE(header, 16, entry.crc32);
    if (needsZip64) {
      writeUint32LE(header, 20, 0xffffffff);
      writeUint32LE(header, 24, 0xffffffff);
    } else {
      writeUint32LE(header, 20, Number(entry.compressedSize));
      writeUint32LE(header, 24, Number(entry.uncompressedSize));
    }
    writeUint16LE(header, 28, nameBytes.length);
    writeUint16LE(header, 30, extra.length);
    writeUint16LE(header, 32, commentBytes.length);
    writeUint16LE(header, 34, 0);
    writeUint16LE(header, 36, 0);
    writeUint32LE(header, 38, entry.externalAttributes);
    if (needsZip64) {
      writeUint32LE(header, 42, 0xffffffff);
    } else {
      writeUint32LE(header, 42, Number(entry.offset));
    }

    header.set(nameBytes, 46);
    header.set(extra, 46 + nameBytes.length);
    header.set(commentBytes, 46 + nameBytes.length + extra.length);

    await sink.write(header);
    size += BigInt(header.length);
  }

  return { offset, size };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    if (part.length === 0) continue;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
