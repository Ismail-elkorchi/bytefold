import { Readable } from 'node:stream';
import { createInflateRaw, createZstdDecompress } from 'node:zlib';
import { readUint16LE, readUint32LE } from '../binary.js';
import { ZipError, ZipWarning } from '../errors.js';
import { createCrcTransform } from '../streams/crcTransform.js';
import type { RandomAccess } from './RandomAccess.js';
import type { ZipEntryRecord } from './centralDirectory.js';

const LFH_SIGNATURE = 0x04034b50;
export interface OpenEntryOptions {
  strict: boolean;
  onWarning?: (warning: ZipWarning) => void;
}

export async function openRawStream(
  reader: RandomAccess,
  entry: ZipEntryRecord
): Promise<{ stream: ReadableStream<Uint8Array>; dataOffset: bigint }> {
  const header = await reader.read(entry.offset, 30);
  if (header.length < 30 || readUint32LE(header, 0) !== LFH_SIGNATURE) {
    throw new ZipError('ZIP_INVALID_SIGNATURE', 'Invalid local file header signature', {
      entryName: entry.name,
      offset: entry.offset
    });
  }
  const nameLen = readUint16LE(header, 26);
  const extraLen = readUint16LE(header, 28);
  const dataOffset = entry.offset + 30n + BigInt(nameLen + extraLen);
  const stream = createRangeStream(reader, dataOffset, entry.compressedSize);
  return { stream, dataOffset };
}

export async function openEntryStream(
  reader: RandomAccess,
  entry: ZipEntryRecord,
  options: OpenEntryOptions
): Promise<ReadableStream<Uint8Array>> {
  if (entry.encrypted) {
    throw new ZipError('ZIP_UNSUPPORTED_FEATURE', 'Encrypted entries are not supported', {
      entryName: entry.name
    });
  }

  const { stream: rawStream } = await openRawStream(reader, entry);

  let decompressed: ReadableStream<Uint8Array>;
  switch (entry.method) {
    case 0:
      decompressed = rawStream;
      break;
    case 8:
      decompressed = inflateRawStream(rawStream);
      break;
    case 93:
      decompressed = zstdDecompressStream(rawStream);
      break;
    default:
      throw new ZipError('ZIP_UNSUPPORTED_METHOD', `Unsupported compression method ${entry.method}`, {
        entryName: entry.name,
        method: entry.method
      });
  }

  const crcResult = { crc32: 0, bytes: 0n };
  const crcStream = createCrcTransform(crcResult, {
    expectedCrc: entry.crc32,
    expectedSize: entry.uncompressedSize,
    strict: options.strict,
    entryName: entry.name,
    onWarning: (warn) => {
      options.onWarning?.({
        code: 'ZIP_BAD_CRC',
        message: warn.message,
        entryName: entry.name
      });
    }
  });

  return decompressed.pipeThrough(crcStream);
}

function createRangeStream(
  reader: RandomAccess,
  offset: bigint,
  length: bigint
): ReadableStream<Uint8Array> {
  const chunkSize = 64 * 1024;
  let position = offset;
  let remaining = length;

  return new ReadableStream({
    async pull(controller) {
      if (remaining <= 0n) {
        controller.close();
        return;
      }
      const size = remaining > BigInt(chunkSize) ? chunkSize : Number(remaining);
      const chunk = await reader.read(position, size);
      if (chunk.length === 0) {
        controller.close();
        return;
      }
      position += BigInt(chunk.length);
      remaining -= BigInt(chunk.length);
      controller.enqueue(chunk);
    }
  });
}

function inflateRawStream(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const nodeReadable = Readable.fromWeb(input as any);
  const inflated = nodeReadable.pipe(createInflateRaw());
  return Readable.toWeb(inflated) as ReadableStream<Uint8Array>;
}

function zstdDecompressStream(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  if (typeof createZstdDecompress !== 'function') {
    throw new ZipError('ZIP_ZSTD_UNAVAILABLE', 'Zstandard support is not available in this Node runtime');
  }
  const nodeReadable = Readable.fromWeb(input as any);
  const inflated = nodeReadable.pipe(createZstdDecompress());
  return Readable.toWeb(inflated) as ReadableStream<Uint8Array>;
}
