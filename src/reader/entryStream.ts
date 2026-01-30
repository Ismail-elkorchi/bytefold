import { ZipError, ZipWarning } from '../errors.js';
import { parseAesExtra, parseExtraFields } from '../extraFields.js';
import { createZipCryptoDecryptTransform, decryptZipCryptoHeader } from '../crypto/zipcrypto.js';
import {
  createAesDecryptionTransform,
  deriveAesKeys,
  getAesSaltLength,
  passwordVerifierMatches
} from '../crypto/winzip-aes.js';
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

  if (local.method === 99) {
    const extraFields = parseExtraFields(local.extra);
    const aesExtraData = extraFields.get(0x9901) ?? entry.extra.get(0x9901);
    const aesExtra = aesExtraData ? parseAesExtra(aesExtraData) : undefined;
    if (!aesExtra) {
      throw new ZipError('ZIP_UNSUPPORTED_ENCRYPTION', 'Missing AES extra field', { entryName: entry.name });
    }

    const saltLen = getAesSaltLength(aesExtra.strength);
    const overhead = saltLen + 2 + 10;
    if (entry.compressedSize < BigInt(overhead)) {
      throw new ZipError('ZIP_TRUNCATED', 'Encrypted data truncated', { entryName: entry.name });
    }

    const saltAndPwv = await reader.read(local.dataOffset, saltLen + 2, options.signal);
    if (saltAndPwv.length < saltLen + 2) {
      throw new ZipError('ZIP_TRUNCATED', 'Encrypted data truncated', { entryName: entry.name });
    }
    const readTracker = createProgressTracker(options, {
      kind: 'read',
      entryName: entry.name,
      totalOut: entry.compressedSize,
      totalIn: entry.compressedSize
    });
    readTracker?.update(saltLen + 2, saltLen + 2);
    const salt = saltAndPwv.subarray(0, saltLen);
    const pwv = saltAndPwv.subarray(saltLen);
    const keys = deriveAesKeys(password, salt, aesExtra.strength);
    if (!passwordVerifierMatches(keys.pwv, pwv)) {
      throw new ZipError('ZIP_BAD_PASSWORD', 'Incorrect password', { entryName: entry.name });
    }

    const cipherOffset = local.dataOffset + BigInt(saltLen + 2);
    const cipherSize = entry.compressedSize - BigInt(overhead);
    const authOffset = cipherOffset + cipherSize;
    const authCode = await reader.read(authOffset, 10, options.signal);
    if (authCode.length < 10) {
      throw new ZipError('ZIP_TRUNCATED', 'Encrypted data truncated', { entryName: entry.name });
    }
    readTracker?.update(10, 10);

    let cipherStream = createRangeStream(reader, cipherOffset, cipherSize, options.signal);
    cipherStream = cipherStream.pipeThrough(createProgressTransform(readTracker));
    cipherStream = cipherStream.pipeThrough(
      createAesDecryptionTransform(keys.encKey, keys.authKey, authCode, entry.name)
    );
    const decryptTracker = createProgressTracker(options, {
      kind: 'decrypt',
      entryName: entry.name,
      totalOut: cipherSize,
      totalIn: cipherSize
    });
    cipherStream = cipherStream.pipeThrough(createProgressTransform(decryptTracker));

    const expectedCrc = aesExtra.vendorVersion === 1 ? entry.crc32 : undefined;
    return decodeAndValidate(cipherStream, aesExtra.actualMethod, entry, options, expectedCrc);
  }

  if ((local.flags & 0x40) !== 0) {
    throw new ZipError('ZIP_UNSUPPORTED_ENCRYPTION', 'Strong encryption is not supported', {
      entryName: entry.name
    });
  }

  if (entry.compressedSize < 12n) {
    throw new ZipError('ZIP_TRUNCATED', 'Encrypted data truncated', { entryName: entry.name });
  }
  const readTracker = createProgressTracker(options, {
    kind: 'read',
    entryName: entry.name,
    totalOut: entry.compressedSize,
    totalIn: entry.compressedSize
  });
  const encHeader = await reader.read(local.dataOffset, 12, options.signal);
  if (encHeader.length < 12) {
    throw new ZipError('ZIP_TRUNCATED', 'Encrypted data truncated', { entryName: entry.name });
  }
  readTracker?.update(12, 12);
  const { header: plainHeader, keys } = decryptZipCryptoHeader(password, encHeader);
  const expectedByte = (local.flags & 0x08) !== 0 ? (local.modTime >>> 8) & 0xff : (entry.crc32 >>> 24) & 0xff;
  if (plainHeader[11] !== expectedByte) {
    throw new ZipError('ZIP_BAD_PASSWORD', 'Incorrect password', { entryName: entry.name });
  }

  const dataOffset = local.dataOffset + 12n;
  const dataSize = entry.compressedSize - 12n;
  let dataStream = createRangeStream(reader, dataOffset, dataSize, options.signal);
  dataStream = dataStream.pipeThrough(createProgressTransform(readTracker));
  dataStream = dataStream.pipeThrough(createZipCryptoDecryptTransform(keys));
  const decryptTracker = createProgressTracker(options, {
    kind: 'decrypt',
    entryName: entry.name,
    totalOut: dataSize,
    totalIn: dataSize
  });
  dataStream = dataStream.pipeThrough(createProgressTransform(decryptTracker));

  return decodeAndValidate(dataStream, local.method, entry, options, entry.crc32);
}

function decodeAndValidate(
  rawStream: ReadableStream<Uint8Array>,
  method: number,
  entry: ZipEntryRecord,
  options: OpenEntryOptions,
  expectedCrc: number | undefined
): ReadableStream<Uint8Array> {
  const codec = getCompressionCodec(method);
  if (!codec) {
    throw new ZipError('ZIP_UNSUPPORTED_METHOD', `Unsupported compression method ${method}`, {
      entryName: entry.name,
      method
    });
  }
  const decompressed = rawStream.pipeThrough(
    codec.createDecompressStream(options.signal ? { signal: options.signal } : undefined)
  );
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
  length: bigint,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  const chunkSize = 64 * 1024;
  let position = offset;
  let remaining = length;

  return new ReadableStream({
    async pull(controller) {
      throwIfAborted(signal);
      if (remaining <= 0n) {
        controller.close();
        return;
      }
      const size = remaining > BigInt(chunkSize) ? chunkSize : Number(remaining);
      const chunk = await reader.read(position, size, signal);
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
