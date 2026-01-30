import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createDeflateRaw, createZstdCompress } from 'node:zlib';
import { encodeUtf8, writeUint16LE, writeUint32LE, writeUint64LE } from '../binary.js';
import { dateToDos } from '../dosTime.js';
import { buildAesExtra, buildExtendedTimestampExtra, buildZip64Extra } from '../extraFields.js';
import { ZipError } from '../errors.js';
import { createZipCryptoEncryptTransform, createZipCryptoHeader } from '../crypto/zipcrypto.js';
import { createAesEncryptionTransform, deriveAesKeys, generateSalt } from '../crypto/winzip-aes.js';
import { toWebReadable } from '../streams/adapters.js';
import { createCrcTransform } from '../streams/crcTransform.js';
import { createMeasureTransform } from '../streams/measure.js';
import { createProgressTracker, createProgressTransform } from '../streams/progress.js';
import { throwIfAborted } from '../abort.js';
import { NodeWritableSink } from './Sink.js';
import type { SeekableSink, Sink } from './Sink.js';
import type { ZipEncryption, Zip64Mode, ZipProgressOptions } from '../types.js';

const LFH_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

export interface EntryWriteResult {
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: bigint;
  uncompressedSize: bigint;
  offset: bigint;
  mtime: Date;
  comment?: string | undefined;
  externalAttributes: number;
  zip64: boolean;
  versionNeeded: number;
  aesExtra?: Uint8Array;
}

export interface EntryWriteInput {
  name: string;
  source: ReadableStream<Uint8Array>;
  method: number;
  mtime: Date;
  comment?: string | undefined;
  externalAttributes?: number;
  zip64Mode: Zip64Mode;
  forceZip64: boolean;
  patchLocalHeader: boolean;
  encryption: ZipEncryption;
  sizeHint?: bigint;
  declaredUncompressedSize?: bigint;
  signal?: AbortSignal;
  progress?: ZipProgressOptions;
}

export async function writeEntry(sink: Sink | SeekableSink, input: EntryWriteInput): Promise<EntryWriteResult> {
  throwIfAborted(input.signal);
  if (input.encryption.type === 'zipcrypto' && input.patchLocalHeader) {
    return writeZipCryptoSeekable(sink, input);
  }
  return writeStreamingEntry(sink, input);
}

async function writeStreamingEntry(sink: Sink | SeekableSink, input: EntryWriteInput): Promise<EntryWriteResult> {
  throwIfAborted(input.signal);
  const nameBytes = encodeUtf8(input.name);
  const dos = dateToDos(input.mtime);
  const writeTracker = createProgressTracker(input.progress, {
    kind: 'write',
    entryName: input.name
  });
  const encrypted = input.encryption.type !== 'none';
  // APPNOTE 6.3.10 section 4.3.9: bit 3 indicates data descriptor follows file data.
  const flags = (input.patchLocalHeader ? 0 : 0x08) | 0x800 | (encrypted ? 0x01 : 0); // UTF-8 (+ data descriptor if streaming)
  const headerMethod = input.encryption.type === 'aes' ? 99 : input.method;
  const useZip64 = input.patchLocalHeader
    ? shouldUseZip64ForPatch(input, sink.position)
    : shouldUseZip64(input, sink.position);
  const baseVersion = useZip64 ? 45 : 20;
  const versionNeeded = input.encryption.type === 'aes' ? Math.max(baseVersion, 51) : baseVersion;
  const aesExtra =
    input.encryption.type === 'aes'
      ? buildAesExtra({
          vendorVersion: input.encryption.vendorVersion ?? 2,
          strength: input.encryption.strength ?? 256,
          actualMethod: input.method
        })
      : undefined;
  const localExtras = [
    useZip64
      ? buildZip64Extra({
          uncompressedSize: 0n,
          compressedSize: 0n
        })
      : new Uint8Array(0),
    aesExtra ?? new Uint8Array(0),
    buildExtendedTimestampExtra({ mtime: input.mtime }, false)
  ];
  const localExtra = concat(localExtras);

  const header = new Uint8Array(30 + nameBytes.length + localExtra.length);
  writeUint32LE(header, 0, LFH_SIGNATURE);
  writeUint16LE(header, 4, versionNeeded);
  writeUint16LE(header, 6, flags);
  writeUint16LE(header, 8, headerMethod);
  writeUint16LE(header, 10, dos.time);
  writeUint16LE(header, 12, dos.date);
  writeUint32LE(header, 14, 0);
  if (useZip64) {
    if (input.patchLocalHeader) {
      writeUint32LE(header, 18, 0);
      writeUint32LE(header, 22, 0);
    } else {
      writeUint32LE(header, 18, 0xffffffff);
      writeUint32LE(header, 22, 0xffffffff);
    }
  } else {
    writeUint32LE(header, 18, 0);
    writeUint32LE(header, 22, 0);
  }
  writeUint16LE(header, 26, nameBytes.length);
  writeUint16LE(header, 28, localExtra.length);
  header.set(nameBytes, 30);
  header.set(localExtra, 30 + nameBytes.length);

  const offset = sink.position;
  await sink.write(header);
  writeTracker?.update(header.length, header.length);

  const crcResult = { crc32: 0, bytes: 0n };
  const measure = { bytes: 0n };
  const totalUncompressed = input.declaredUncompressedSize ?? input.sizeHint;
  const compressTracker = createProgressTracker(input.progress, {
    kind: 'compress',
    entryName: input.name,
    ...(totalUncompressed !== undefined ? { totalIn: totalUncompressed, totalOut: totalUncompressed } : {})
  });
  const encryptTracker =
    input.encryption.type === 'none'
      ? null
      : createProgressTracker(input.progress, {
          kind: 'encrypt',
          entryName: input.name
        });

  let stream = input.source;
  stream = stream.pipeThrough(createCrcTransform(crcResult, { strict: true }));
  stream = stream.pipeThrough(createProgressTransform(compressTracker));
  stream = compressStream(stream, input.method, input.name);

  let authResult: { authCode?: Uint8Array } | undefined;
  let overhead = 0n;
  if (input.encryption.type === 'zipcrypto') {
    const checkByte = (dos.time >>> 8) & 0xff;
    const { header: cryptoHeader, keys } = createZipCryptoHeader(input.encryption.password, { checkByte });
    await sink.write(cryptoHeader);
    writeTracker?.update(cryptoHeader.length, cryptoHeader.length);
    overhead += 12n;
    stream = stream.pipeThrough(createZipCryptoEncryptTransform(keys));
    stream = stream.pipeThrough(createProgressTransform(encryptTracker));
  } else if (input.encryption.type === 'aes') {
    const strength = input.encryption.strength ?? 256;
    const salt = generateSalt(strength);
    const keys = deriveAesKeys(input.encryption.password, salt, strength);
    await sink.write(salt);
    await sink.write(keys.pwv);
    writeTracker?.update(salt.length + keys.pwv.length, salt.length + keys.pwv.length);
    overhead += BigInt(salt.length + keys.pwv.length + 10);
    authResult = {};
    stream = stream.pipeThrough(createAesEncryptionTransform(keys.encKey, keys.authKey, authResult));
    stream = stream.pipeThrough(createProgressTransform(encryptTracker));
  }

  stream = stream.pipeThrough(createMeasureTransform(measure));
  await pipeToSink(stream, sink, input.signal, writeTracker);

  if (authResult) {
    const authCode = authResult.authCode;
    if (!authCode) {
      throw new ZipError('ZIP_AUTH_FAILED', 'AES authentication code missing', { entryName: input.name });
    }
    await sink.write(authCode);
    writeTracker?.update(authCode.length, authCode.length);
  }

  const crc32 = crcResult.crc32;
  const uncompressedSize = crcResult.bytes;
  const compressedSize = measure.bytes + overhead;
  const uncompressedForCheck = input.declaredUncompressedSize ?? uncompressedSize;
  const requiresZip64 = uncompressedForCheck > 0xffffffffn || compressedSize > 0xffffffffn;

  if (!useZip64 && requiresZip64) {
    if (input.patchLocalHeader && input.zip64Mode === 'auto' && input.sizeHint === undefined && !input.forceZip64) {
      throw new ZipError(
        'ZIP_ZIP64_REQUIRED',
        'Entry exceeded 4GiB; enable zip64:"force" (entry) or forceZip64 (writer) for seekable mode',
        { entryName: input.name }
      );
    }
    throw new ZipError('ZIP_LIMIT_EXCEEDED', 'Entry requires ZIP64 but zip64 mode is off', {
      entryName: input.name
    });
  }

  const storedCrc32 = input.encryption.type === 'aes' && (input.encryption.vendorVersion ?? 2) === 2 ? 0 : crc32;
  if (input.patchLocalHeader) {
    const seekable = sink as SeekableSink;
    if (typeof seekable.writeAt !== 'function') {
      throw new ZipError('ZIP_SINK_NOT_SEEKABLE', 'Seekable mode requires a seekable sink');
    }
    const patch = new Uint8Array(12);
    writeUint32LE(patch, 0, storedCrc32);
    if (useZip64) {
      writeUint32LE(patch, 4, 0xffffffff);
      writeUint32LE(patch, 8, 0xffffffff);
    } else {
      writeUint32LE(patch, 4, Number(compressedSize));
      writeUint32LE(patch, 8, Number(uncompressedSize));
    }
    await seekable.writeAt(offset + 14n, patch);

    if (useZip64) {
      const zip64Patch = new Uint8Array(16);
      // Zip64 extra field ordering: uncompressed size, compressed size.
      writeUint64LE(zip64Patch, 0, uncompressedSize);
      writeUint64LE(zip64Patch, 8, compressedSize);
      const zip64DataOffset = 30 + nameBytes.length + 4;
      await seekable.writeAt(offset + BigInt(zip64DataOffset), zip64Patch);
    }
  } else {
    const descriptor = buildDataDescriptor(storedCrc32, compressedSize, uncompressedSize, useZip64);
    await sink.write(descriptor);
    writeTracker?.update(descriptor.length, descriptor.length);
  }

  return {
    name: input.name,
    nameBytes,
    flags,
    method: headerMethod,
    crc32: storedCrc32,
    compressedSize,
    uncompressedSize,
    offset,
    mtime: input.mtime,
    comment: input.comment,
    externalAttributes: input.externalAttributes ?? 0,
    zip64: useZip64,
    versionNeeded,
    ...(aesExtra ? { aesExtra } : {})
  };
}

async function writeZipCryptoSeekable(sink: Sink | SeekableSink, input: EntryWriteInput): Promise<EntryWriteResult> {
  throwIfAborted(input.signal);
  const password = input.encryption.type === 'zipcrypto' ? input.encryption.password : undefined;
  if (!password) {
    throw new ZipError('ZIP_PASSWORD_REQUIRED', 'Password required for ZipCrypto encryption');
  }
  const { tempPath, tempDir, compressedSize, crc32, uncompressedSize } = await spoolCompressedData(input);
  const writeTracker = createProgressTracker(input.progress, {
    kind: 'write',
    entryName: input.name
  });
  const encryptTracker = createProgressTracker(input.progress, {
    kind: 'encrypt',
    entryName: input.name
  });
  try {
    const nameBytes = encodeUtf8(input.name);
    const dos = dateToDos(input.mtime);
    const flags = 0x800 | 0x01;
    const uncompressedForCheck = input.declaredUncompressedSize ?? uncompressedSize;
    const requiresZip64 =
      sink.position > 0xffffffffn || compressedSize + 12n > 0xffffffffn || uncompressedForCheck > 0xffffffffn;
    const useZip64 = shouldUseZip64ForKnownSizes(
      input,
      sink.position,
      compressedSize + 12n,
      uncompressedForCheck
    );
    if (!useZip64 && requiresZip64) {
      throw new ZipError('ZIP_LIMIT_EXCEEDED', 'Entry requires ZIP64 but zip64 mode is off', {
        entryName: input.name
      });
    }
    const versionNeeded = useZip64 ? 45 : 20;
    const localExtras = [
      useZip64
        ? buildZip64Extra({
            uncompressedSize,
            compressedSize: compressedSize + 12n
          })
        : new Uint8Array(0),
      buildExtendedTimestampExtra({ mtime: input.mtime }, false)
    ];
    const localExtra = concat(localExtras);

    const header = new Uint8Array(30 + nameBytes.length + localExtra.length);
    writeUint32LE(header, 0, LFH_SIGNATURE);
    writeUint16LE(header, 4, versionNeeded);
    writeUint16LE(header, 6, flags);
    writeUint16LE(header, 8, input.method);
    writeUint16LE(header, 10, dos.time);
    writeUint16LE(header, 12, dos.date);
    writeUint32LE(header, 14, crc32);
    if (useZip64) {
      writeUint32LE(header, 18, 0xffffffff);
      writeUint32LE(header, 22, 0xffffffff);
    } else {
      writeUint32LE(header, 18, Number(compressedSize + 12n));
      writeUint32LE(header, 22, Number(uncompressedSize));
    }
    writeUint16LE(header, 26, nameBytes.length);
    writeUint16LE(header, 28, localExtra.length);
    header.set(nameBytes, 30);
    header.set(localExtra, 30 + nameBytes.length);

    const offset = sink.position;
    await sink.write(header);
    writeTracker?.update(header.length, header.length);

    const checkWord = (crc32 >>> 16) & 0xffff;
    const { header: cryptoHeader, keys } = createZipCryptoHeader(password, {
      checkByte: (checkWord >>> 8) & 0xff,
      checkWord
    });
    await sink.write(cryptoHeader);
    writeTracker?.update(cryptoHeader.length, cryptoHeader.length);

    const dataStream = toWebReadable(createReadStream(tempPath));
    let encryptedStream = dataStream.pipeThrough(createZipCryptoEncryptTransform(keys));
    encryptedStream = encryptedStream.pipeThrough(createProgressTransform(encryptTracker));
    await pipeToSink(encryptedStream, sink, input.signal, writeTracker);

    return {
      name: input.name,
      nameBytes,
      flags,
      method: input.method,
      crc32,
      compressedSize: compressedSize + 12n,
      uncompressedSize,
      offset,
      mtime: input.mtime,
      comment: input.comment,
      externalAttributes: input.externalAttributes ?? 0,
      zip64: useZip64,
      versionNeeded
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function compressStream(
  input: ReadableStream<Uint8Array>,
  method: number,
  entryName: string
): ReadableStream<Uint8Array> {
  if (method === 8) {
    return deflateStream(input);
  }
  if (method === 93) {
    return zstdCompressStream(input);
  }
  if (method !== 0) {
    throw new ZipError('ZIP_UNSUPPORTED_METHOD', `Unsupported compression method ${method}`, {
      entryName,
      method
    });
  }
  return input;
}

async function spoolCompressedData(
  input: EntryWriteInput
): Promise<{ tempPath: string; tempDir: string; compressedSize: bigint; crc32: number; uncompressedSize: bigint }> {
  throwIfAborted(input.signal);
  const tempDir = await mkdtemp(path.join(tmpdir(), 'zip-next-'));
  const tempPath = path.join(tempDir, 'spool.bin');
  const sink = new NodeWritableSink(createWriteStream(tempPath));
  try {
    const crcResult = { crc32: 0, bytes: 0n };
    const measure = { bytes: 0n };
    const totalUncompressed = input.declaredUncompressedSize ?? input.sizeHint;
    const compressTracker = createProgressTracker(input.progress, {
      kind: 'compress',
      entryName: input.name,
      ...(totalUncompressed !== undefined ? { totalIn: totalUncompressed, totalOut: totalUncompressed } : {})
    });

    let stream = input.source;
    stream = stream.pipeThrough(createCrcTransform(crcResult, { strict: true }));
    stream = stream.pipeThrough(createProgressTransform(compressTracker));
    stream = compressStream(stream, input.method, input.name);
    stream = stream.pipeThrough(createMeasureTransform(measure));
    await pipeToSink(stream, sink, input.signal);
    await sink.close();
    return {
      tempPath,
      tempDir,
      compressedSize: measure.bytes,
      crc32: crcResult.crc32,
      uncompressedSize: crcResult.bytes
    };
  } catch (err) {
    await sink.close().catch(() => {});
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

function shouldUseZip64ForKnownSizes(
  input: EntryWriteInput,
  offset: bigint,
  compressedSize: bigint,
  uncompressedSize: bigint
): boolean {
  if (input.forceZip64) return true;
  if (input.zip64Mode === 'force') return true;
  const requiresZip64 = offset > 0xffffffffn || compressedSize > 0xffffffffn || uncompressedSize > 0xffffffffn;
  if (input.zip64Mode === 'off') {
    if (requiresZip64) {
      throw new ZipError('ZIP_LIMIT_EXCEEDED', 'Entry requires ZIP64 but zip64 mode is off', {
        entryName: input.name
      });
    }
    return false;
  }
  return requiresZip64;
}

function shouldUseZip64(input: EntryWriteInput, offset: bigint): boolean {
  if (input.forceZip64) return true;
  if (input.zip64Mode === 'force') return true;
  if (input.zip64Mode === 'off') return false;
  if (offset > 0xffffffffn) return true;
  if (input.sizeHint !== undefined && input.sizeHint > 0xffffffffn) return true;
  if (input.sizeHint === undefined) return true; // streaming size unknown; use ZIP64-safe headers
  return false;
}

function shouldUseZip64ForPatch(input: EntryWriteInput, offset: bigint): boolean {
  if (input.forceZip64) return true;
  if (input.zip64Mode === 'force') return true;
  if (input.zip64Mode === 'off') {
    if (offset > 0xffffffffn || (input.sizeHint !== undefined && input.sizeHint > 0xffffffffn)) {
      throw new ZipError('ZIP_LIMIT_EXCEEDED', 'Entry requires ZIP64 but zip64 mode is off', {
        entryName: input.name
      });
    }
    return false;
  }
  if (offset > 0xffffffffn) return true;
  if (input.sizeHint !== undefined && input.sizeHint > 0xffffffffn) return true;
  return false;
}

function buildDataDescriptor(
  crc32: number,
  compressedSize: bigint,
  uncompressedSize: bigint,
  zip64: boolean
): Uint8Array {
  if (zip64) {
    const out = new Uint8Array(4 + 4 + 8 + 8);
    writeUint32LE(out, 0, DATA_DESCRIPTOR_SIGNATURE);
    writeUint32LE(out, 4, crc32);
    writeUint64LE(out, 8, compressedSize);
    writeUint64LE(out, 16, uncompressedSize);
    return out;
  }
  const out = new Uint8Array(4 + 4 + 4 + 4);
  writeUint32LE(out, 0, DATA_DESCRIPTOR_SIGNATURE);
  writeUint32LE(out, 4, crc32);
  writeUint32LE(out, 8, Number(compressedSize));
  writeUint32LE(out, 12, Number(uncompressedSize));
  return out;
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

async function pipeToSink(
  stream: ReadableStream<Uint8Array>,
  sink: Sink,
  signal?: AbortSignal,
  tracker?: ReturnType<typeof createProgressTracker>
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        await sink.write(value);
        tracker?.update(value.length, value.length);
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
  tracker?.flush();
}

function deflateStream(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const nodeReadable = Readable.fromWeb(input as any);
  const deflated = nodeReadable.pipe(createDeflateRaw());
  return Readable.toWeb(deflated) as ReadableStream<Uint8Array>;
}

function zstdCompressStream(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  if (typeof createZstdCompress !== 'function') {
    throw new ZipError('ZIP_ZSTD_UNAVAILABLE', 'Zstandard support is not available in this Node runtime');
  }
  const nodeReadable = Readable.fromWeb(input as any);
  const deflated = nodeReadable.pipe(createZstdCompress());
  return Readable.toWeb(deflated) as ReadableStream<Uint8Array>;
}
