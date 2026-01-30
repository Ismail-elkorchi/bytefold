import { getCompressionCodec } from '../compression/registry.js';
import { encodeUtf8, writeUint16LE, writeUint32LE, writeUint64LE } from '../binary.js';
import { dateToDos } from '../dosTime.js';
import { buildExtendedTimestampExtra, buildZip64Extra } from '../extraFields.js';
import { ZipError } from '../errors.js';
import { createCrcTransform } from '../streams/crcTransform.js';
import { createMeasureTransform } from '../streams/measure.js';
import { createProgressTracker, createProgressTransform } from '../streams/progress.js';
import { throwIfAborted } from '../abort.js';
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

export interface RawEntryWriteInput {
  name: string;
  source: ReadableStream<Uint8Array>;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: bigint;
  uncompressedSize: bigint;
  mtime: Date;
  comment?: string | undefined;
  externalAttributes?: number;
  zip64Mode: Zip64Mode;
  forceZip64: boolean;
  aesExtra?: Uint8Array;
  signal?: AbortSignal;
  progress?: ZipProgressOptions;
}

export async function writeEntry(sink: Sink | SeekableSink, input: EntryWriteInput): Promise<EntryWriteResult> {
  throwIfAborted(input.signal);
  if (input.encryption.type !== 'none') {
    throw new ZipError('ZIP_UNSUPPORTED_ENCRYPTION', 'Encryption is not supported in this runtime');
  }
  return writeStreamingEntry(sink, input);
}

export async function writeRawEntry(sink: Sink, input: RawEntryWriteInput): Promise<EntryWriteResult> {
  throwIfAborted(input.signal);
  const nameBytes = encodeUtf8(input.name);
  const dos = dateToDos(input.mtime);
  const writeTracker = createProgressTracker(input.progress, {
    kind: 'write',
    entryName: input.name,
    totalOut: input.compressedSize,
    totalIn: input.compressedSize
  });

  const useZip64 = shouldUseZip64ForKnownSizes(
    input,
    sink.position,
    input.compressedSize,
    input.uncompressedSize
  );
  const baseVersion = useZip64 ? 45 : 20;
  const versionNeeded = input.aesExtra ? Math.max(baseVersion, 51) : baseVersion;

  const localExtras = [
    useZip64
      ? buildZip64Extra({
          uncompressedSize: input.uncompressedSize,
          compressedSize: input.compressedSize
        })
      : new Uint8Array(0),
    input.aesExtra ?? new Uint8Array(0),
    buildExtendedTimestampExtra({ mtime: input.mtime }, false)
  ];
  const localExtra = concat(localExtras);

  const header = new Uint8Array(30 + nameBytes.length + localExtra.length);
  writeUint32LE(header, 0, LFH_SIGNATURE);
  writeUint16LE(header, 4, versionNeeded);
  writeUint16LE(header, 6, input.flags);
  writeUint16LE(header, 8, input.method);
  writeUint16LE(header, 10, dos.time);
  writeUint16LE(header, 12, dos.date);
  writeUint32LE(header, 14, input.crc32);
  if (useZip64) {
    writeUint32LE(header, 18, 0xffffffff);
    writeUint32LE(header, 22, 0xffffffff);
  } else {
    writeUint32LE(header, 18, Number(input.compressedSize));
    writeUint32LE(header, 22, Number(input.uncompressedSize));
  }
  writeUint16LE(header, 26, nameBytes.length);
  writeUint16LE(header, 28, localExtra.length);
  header.set(nameBytes, 30);
  header.set(localExtra, 30 + nameBytes.length);

  const offset = sink.position;
  await sink.write(header);
  writeTracker?.update(header.length, header.length);

  const measure = { bytes: 0n };
  const measured = input.source.pipeThrough(createMeasureTransform(measure));
  await pipeToSink(measured, sink, input.signal, writeTracker);

  if (measure.bytes !== input.compressedSize) {
    throw new ZipError('ZIP_TRUNCATED', 'Compressed data size mismatch', { entryName: input.name });
  }

  return {
    name: input.name,
    nameBytes,
    flags: input.flags,
    method: input.method,
    crc32: input.crc32,
    compressedSize: input.compressedSize,
    uncompressedSize: input.uncompressedSize,
    offset,
    mtime: input.mtime,
    comment: input.comment,
    externalAttributes: input.externalAttributes ?? 0,
    zip64: useZip64,
    versionNeeded,
    ...(input.aesExtra ? { aesExtra: input.aesExtra } : {})
  };
}

async function writeStreamingEntry(sink: Sink | SeekableSink, input: EntryWriteInput): Promise<EntryWriteResult> {
  throwIfAborted(input.signal);
  const nameBytes = encodeUtf8(input.name);
  const dos = dateToDos(input.mtime);
  const writeTracker = createProgressTracker(input.progress, {
    kind: 'write',
    entryName: input.name
  });
  // APPNOTE 6.3.10 section 4.3.9: bit 3 indicates data descriptor follows file data.
  const flags = (input.patchLocalHeader ? 0 : 0x08) | 0x800; // UTF-8 (+ data descriptor if streaming)
  const useZip64 = input.patchLocalHeader
    ? shouldUseZip64ForPatch(input, sink.position)
    : shouldUseZip64(input, sink.position);
  const versionNeeded = useZip64 ? 45 : 20;
  const localExtras = [
    useZip64
      ? buildZip64Extra({
          uncompressedSize: 0n,
          compressedSize: 0n
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

  let stream = input.source;
  stream = stream.pipeThrough(createCrcTransform(crcResult, { strict: true }));
  stream = stream.pipeThrough(createProgressTransform(compressTracker));
  stream = await compressStream(stream, input.method, input.name);
  stream = stream.pipeThrough(createMeasureTransform(measure));
  await pipeToSink(stream, sink, input.signal, writeTracker);

  const crc32 = crcResult.crc32;
  const uncompressedSize = crcResult.bytes;
  const compressedSize = measure.bytes;
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

  if (input.patchLocalHeader) {
    const seekable = sink as SeekableSink;
    if (typeof seekable.writeAt !== 'function') {
      throw new ZipError('ZIP_SINK_NOT_SEEKABLE', 'Seekable mode requires a seekable sink');
    }
    const patch = new Uint8Array(12);
    writeUint32LE(patch, 0, crc32);
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
    const descriptor = buildDataDescriptor(crc32, compressedSize, uncompressedSize, useZip64);
    await sink.write(descriptor);
    writeTracker?.update(descriptor.length, descriptor.length);
  }

  return {
    name: input.name,
    nameBytes,
    flags,
    method: input.method,
    crc32,
    compressedSize,
    uncompressedSize,
    offset,
    mtime: input.mtime,
    comment: input.comment,
    externalAttributes: input.externalAttributes ?? 0,
    zip64: useZip64,
    versionNeeded
  };
}

async function compressStream(
  input: ReadableStream<Uint8Array>,
  method: number,
  entryName: string
): Promise<ReadableStream<Uint8Array>> {
  const codec = getCompressionCodec(method);
  if (!codec || !codec.createCompressStream) {
    throw new ZipError('ZIP_UNSUPPORTED_METHOD', `Unsupported compression method ${method}`, {
      entryName,
      method
    });
  }
  const transform = await codec.createCompressStream();
  return input.pipeThrough(transform);
}

type Zip64Config = {
  name: string;
  zip64Mode: Zip64Mode;
  forceZip64: boolean;
};

function shouldUseZip64ForKnownSizes(
  input: Zip64Config,
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
