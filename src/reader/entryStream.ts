import { ZipError, ZipWarning } from '../errors.js';
import { parseExtraFields } from '../extraFields.js';
import { createCrcTransform } from '../streams/crcTransform.js';
import { createLimitTransform, type LimitTotals } from '../streams/limits.js';
import { createProgressTracker, createProgressTransform } from '../streams/progress.js';
import type { RandomAccess } from './RandomAccess.js';
import type { ZipEntryRecord } from './centralDirectory.js';
import { readLocalHeader } from './localHeader.js';
import type { ZipLimits, ZipProgressOptions } from '../types.js';
import { throwIfAborted } from '../abort.js';
import { getCompressionCodec } from '../compression/registry.js';

export interface OpenEntryOptions extends ZipProgressOptions {
  strict: boolean;
  onWarning?: (warning: ZipWarning) => void;
  password?: string;
  signal?: AbortSignal;
  limits: Required<ZipLimits>;
  totals?: LimitTotals;
}

export interface OpenRawOptions extends ZipProgressOptions {
  signal?: AbortSignal;
}

export async function openRawStream(
  reader: RandomAccess,
  entry: ZipEntryRecord,
  options?: OpenRawOptions
): Promise<{ stream: ReadableStream<Uint8Array>; dataOffset: bigint }> {
  const local = await readLocalHeader(reader, entry, options?.signal);
  const dataOffset = local.dataOffset;
  const readTracker = createProgressTracker(options, {
    kind: 'read',
    entryName: entry.name,
    totalOut: entry.compressedSize,
    totalIn: entry.compressedSize
  });
  let stream = createRangeStream(reader, dataOffset, entry.compressedSize, options?.signal);
  stream = stream.pipeThrough(createProgressTransform(readTracker));
  return { stream, dataOffset };
}

export async function openEntryStream(
  reader: RandomAccess,
  entry: ZipEntryRecord,
  options: OpenEntryOptions
): Promise<ReadableStream<Uint8Array>> {
  const local = await readLocalHeader(reader, entry, options.signal);
  const encrypted = (local.flags & 0x1) !== 0 || entry.encrypted;

  if (!encrypted) {
    const readTracker = createProgressTracker(options, {
      kind: 'read',
      entryName: entry.name,
      totalOut: entry.compressedSize,
      totalIn: entry.compressedSize
    });
    let rawStream = createRangeStream(reader, local.dataOffset, entry.compressedSize, options.signal);
    rawStream = rawStream.pipeThrough(createProgressTransform(readTracker));
    return decodeAndValidate(rawStream, entry.method, entry, options, entry.crc32);
  }

  const password = options.password;
  if (!password) {
    throw new ZipError('ZIP_PASSWORD_REQUIRED', 'Password required for encrypted entry', {
      entryName: entry.name
    });
  }

  const extraFields = parseExtraFields(local.extra);
  const aesExtraData = extraFields.get(0x9901) ?? entry.extra.get(0x9901);
  if (aesExtraData) {
    throw new ZipError('ZIP_UNSUPPORTED_ENCRYPTION', 'AES encryption is not supported in this runtime', {
      entryName: entry.name
    });
  }

  throw new ZipError('ZIP_UNSUPPORTED_ENCRYPTION', 'Encrypted entries are not supported in this runtime', {
    entryName: entry.name
  });
}

async function decodeAndValidate(
  rawStream: ReadableStream<Uint8Array>,
  method: number,
  entry: ZipEntryRecord,
  options: OpenEntryOptions,
  expectedCrc: number | undefined
): Promise<ReadableStream<Uint8Array>> {
  const codec = getCompressionCodec(method);
  if (!codec) {
    throw new ZipError('ZIP_UNSUPPORTED_METHOD', `Unsupported compression method ${method}`, {
      entryName: entry.name,
      method
    });
  }
  const transform = await codec.createDecompressStream(options.signal ? { signal: options.signal } : undefined);
  const decompressed = rawStream.pipeThrough(transform);
  const limited = decompressed.pipeThrough(
    createLimitTransform({
      entryName: entry.name,
      compressedSize: entry.compressedSize,
      limits: options.limits,
      strict: options.strict,
      ...(options.totals ? { totals: options.totals } : {}),
      ...(options.onWarning ? { onWarning: options.onWarning } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    })
  );

  const crcResult = { crc32: 0, bytes: 0n };
  const crcOptions: {
    expectedCrc?: number;
    expectedSize: bigint;
    strict: boolean;
    entryName: string;
    onWarning: (warn: { message: string }) => void;
  } = {
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
  };
  if (expectedCrc !== undefined) {
    crcOptions.expectedCrc = expectedCrc;
  }
  const crcStream = createCrcTransform(crcResult, crcOptions);
  const extractTracker = createProgressTracker(options, {
    kind: 'extract',
    entryName: entry.name,
    totalOut: entry.uncompressedSize,
    totalIn: entry.uncompressedSize
  });
  return limited.pipeThrough(crcStream).pipeThrough(createProgressTransform(extractTracker));
}

function createRangeStream(
  reader: RandomAccess,
  offset: bigint,
  size: bigint,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  let position = offset;
  let remaining = size;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      throwIfAborted(signal);
      if (remaining <= 0n) {
        controller.close();
        return;
      }
      const chunkSize = remaining > 64n * 1024n ? 64 * 1024 : Number(remaining);
      const chunk = await reader.read(position, chunkSize, signal);
      if (chunk.length === 0) {
        controller.close();
        return;
      }
      position += BigInt(chunk.length);
      remaining -= BigInt(chunk.length);
      controller.enqueue(chunk);
    },
    cancel() {
      return;
    }
  });
}
