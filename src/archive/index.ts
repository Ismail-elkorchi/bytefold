import { ArchiveError } from './errors.js';
import type {
  ArchiveAuditReport,
  ArchiveDetectionReport,
  ArchiveEntry,
  ArchiveFormat,
  ArchiveInputKind,
  ArchiveLimits,
  ArchiveNormalizeReport,
  ArchiveOpenOptions,
  ArchiveProfile
} from './types.js';
import { readAllBytes } from '../streams/buffer.js';
import { readableFromAsyncIterable, readableFromBytes } from '../streams/web.js';
import { createCompressTransform, createDecompressTransform } from '../compression/streams.js';
import { ZipReader } from '../reader/ZipReader.js';
import { ZipWriter } from '../writer/ZipWriter.js';
import { BYTEFOLD_REPORT_SCHEMA_VERSION } from '../reportSchema.js';
import type {
  ZipAuditOptions,
  ZipProfile,
  ZipReaderOptions,
  ZipReaderOpenOptions,
  ZipWriterOptions
} from '../types.js';
import { TarReader } from '../tar/TarReader.js';
import { TarWriter } from '../tar/TarWriter.js';
import type { TarAuditOptions, TarNormalizeOptions, TarReaderOptions, TarWriterOptions } from '../tar/types.js';
import type { CompressionAlgorithm } from '../compress/types.js';

/** Unified archive reader API returned by openArchive(). */
export type ArchiveReader = {
  format: ArchiveFormat;
  detection?: ArchiveDetectionReport;
  entries(): AsyncGenerator<ArchiveEntry>;
  audit(options?: ArchiveAuditOptions): Promise<ArchiveAuditReport>;
  assertSafe(options?: ArchiveAuditOptions): Promise<void>;
  normalizeToWritable?(
    writable: WritableStream<Uint8Array>,
    options?: ArchiveNormalizeOptions
  ): Promise<ArchiveNormalizeReport>;
};

/** Unified archive writer API for ZIP/TAR and layered formats. */
export type ArchiveWriter = {
  format: ArchiveFormat;
  add(
    name: string,
    source?: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    options?: unknown
  ): Promise<void>;
  close(): Promise<void>;
};

/** Options for creating archive writers. */
export type ArchiveWriterOptions = {
  zip?: ZipWriterOptions;
  tar?: TarWriterOptions;
  compression?: { level?: number; quality?: number };
};

/** Options for auditing archives opened via openArchive(). */
export type ArchiveAuditOptions = {
  profile?: ArchiveProfile;
  strict?: boolean;
  limits?: ArchiveLimits;
  signal?: AbortSignal;
};

/** Options for normalization via openArchive(). */
export type ArchiveNormalizeOptions = {
  deterministic?: boolean;
  signal?: AbortSignal;
};

/** Inputs accepted by openArchive(). */
export type ArchiveInput = Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;

/** Open an archive with auto-detection (or a forced format). */
export async function openArchive(input: ArchiveInput, options?: ArchiveOpenOptions): Promise<ArchiveReader> {
  const inputKind = resolveInputKind(input, options?.inputKind);
  const data = await resolveInput(input, options);
  const formatOption = options?.format ?? 'auto';
  const notes: string[] = [];
  let confidence: ArchiveDetectionReport['confidence'] = 'high';

  let format: ArchiveFormat | undefined;
  if (formatOption !== 'auto') {
    format = formatOption;
    notes.push('Format forced by options.format');
  } else {
    const hinted = formatFromFilename(options?.filename);
    if (hinted) {
      format = hinted;
      confidence = 'medium';
      notes.push('Format inferred from filename');
    } else {
      format = detectFormat(data);
      if (!format) {
        throw new ArchiveError('ARCHIVE_UNSUPPORTED_FORMAT', 'Unable to detect archive format');
      }
      notes.push('Format inferred from magic bytes');
    }
  }

  const result = await openWithFormat(format, data, options);
  const report = buildDetectionReport(inputKind, result.format, confidence, [...notes, ...result.notes]);
  const reader = result.reader;
  reader.detection = report;
  return reader;
}

/** Create an archive writer for a specific format. */
export function createArchiveWriter(
  format: ArchiveFormat,
  writable: WritableStream<Uint8Array>,
  options?: ArchiveWriterOptions
): ArchiveWriter {
  if (format === 'zip') {
    const writer = ZipWriter.toWritable(writable, options?.zip);
    return {
      format: 'zip',
      add: (name, source, addOptions) =>
        writer.add(
          name,
          source as Parameters<typeof writer.add>[1],
          addOptions as Parameters<typeof writer.add>[2]
        ),
      close: () => writer.close()
    };
  }
  if (format === 'tar') {
    const writer = TarWriter.toWritable(writable, options?.tar);
    return {
      format: 'tar',
      add: (name, source, addOptions) =>
        writer.add(
          name,
          source as Parameters<typeof writer.add>[1],
          addOptions as Parameters<typeof writer.add>[2]
        ),
      close: () => writer.close()
    };
  }
  if (format === 'tgz' || format === 'tar.gz') {
    return createCompressedTarWriter(format, 'gzip', writable, options);
  }
  if (format === 'tar.zst') {
    return createCompressedTarWriter('tar.zst', 'zstd', writable, options);
  }
  if (format === 'tar.br') {
    return createCompressedTarWriter('tar.br', 'brotli', writable, options);
  }
  if (format === 'tar.bz2' || format === 'bz2') {
    throw new ArchiveError('ARCHIVE_UNSUPPORTED_FORMAT', 'BZip2 compression is not supported for writing');
  }
  if (format === 'tar.xz' || format === 'xz') {
    throw new ArchiveError('ARCHIVE_UNSUPPORTED_FORMAT', 'XZ compression is not supported for writing');
  }
  if (format === 'gz') {
    return createCompressedStreamWriter('gz', 'gzip', writable, options);
  }
  if (format === 'zst') {
    return createCompressedStreamWriter('zst', 'zstd', writable, options);
  }
  if (format === 'br') {
    return createCompressedStreamWriter('br', 'brotli', writable, options);
  }
  throw new ArchiveError('ARCHIVE_UNSUPPORTED_FORMAT', `Unsupported writer format: ${format}`);
}

function createCompressedTarWriter(
  format: ArchiveFormat,
  algorithm: CompressionAlgorithm,
  writable: WritableStream<Uint8Array>,
  options?: ArchiveWriterOptions
): ArchiveWriter {
  let initPromise:
    | Promise<{ writer: TarWriter; pipe: Promise<void> }>
    | null = null;

  const init = async () => {
    if (!initPromise) {
      initPromise = (async () => {
        const transform = await createCompressTransform({
          algorithm,
          ...(options?.tar?.signal ? { signal: options.tar.signal } : {}),
          ...(options?.compression?.level !== undefined ? { level: options.compression.level } : {}),
          ...(options?.compression?.quality !== undefined ? { quality: options.compression.quality } : {})
        });
        const pipe = transform.readable.pipeTo(writable, {
          ...(options?.tar?.signal ? { signal: options.tar.signal } : {})
        });
        const writer = TarWriter.toWritable(transform.writable, options?.tar);
        return { writer, pipe };
      })();
    }
    return initPromise;
  };

  return {
    format,
    add: async (name, source, addOptions) => {
      const { writer } = await init();
      await writer.add(
        name,
        source as Parameters<typeof writer.add>[1],
        addOptions as Parameters<typeof writer.add>[2]
      );
    },
    close: async () => {
      const { writer, pipe } = await init();
      await writer.close();
      await pipe;
    }
  };
}

function createCompressedStreamWriter(
  format: ArchiveFormat,
  algorithm: CompressionAlgorithm,
  writable: WritableStream<Uint8Array>,
  options?: ArchiveWriterOptions
): ArchiveWriter {
  let started = false;
  let done: Promise<void> | null = null;

  const run = async (source?: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>) => {
    const input = sourceToReadable(source);
    const transform = await createCompressTransform({
      algorithm,
      ...(options?.compression?.level !== undefined ? { level: options.compression.level } : {}),
      ...(options?.compression?.quality !== undefined ? { quality: options.compression.quality } : {})
    });
    const outputPipe = transform.readable.pipeTo(writable);
    const inputPipe = input.pipeTo(transform.writable);
    await Promise.all([inputPipe, outputPipe]);
  };

  return {
    format,
    add: async (_name, source) => {
      if (started) {
        throw new ArchiveError('ARCHIVE_UNSUPPORTED_FEATURE', 'Compressed stream writers accept a single entry');
      }
      started = true;
      done = run(source as Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | undefined);
      await done;
    },
    close: async () => {
      if (!done) {
        done = run(new Uint8Array(0));
      }
      await done;
    }
  };
}

function sourceToReadable(
  source?: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
): ReadableStream<Uint8Array> {
  if (!source) return readableFromBytes(new Uint8Array(0));
  if (source instanceof Uint8Array) return readableFromBytes(source);
  if (source instanceof ArrayBuffer) return readableFromBytes(new Uint8Array(source));
  if (isReadableStream(source)) return source;
  return readableFromAsyncIterable(source);
}

async function openWithFormat(
  format: ArchiveFormat,
  data: Uint8Array,
  options?: ArchiveOpenOptions
): Promise<{ reader: ArchiveReader; format: ArchiveFormat; notes: string[] }> {
  const notes: string[] = [];
  if (format === 'zip') {
    const zipOptions: ZipReaderOptions = { ...(options?.zip ?? {}) };
    const profile = options?.profile;
    if (profile !== undefined) zipOptions.profile = profile as ZipProfile;
    if (options?.strict !== undefined) zipOptions.strict = options.strict;
    if (options?.limits !== undefined) zipOptions.limits = options.limits;
    if (options?.password !== undefined) zipOptions.password = options.password;
    const reader = await ZipReader.fromUint8Array(data, zipOptions);
    const openOptions: ZipReaderOpenOptions = {
      ...(options?.strict !== undefined ? { strict: options.strict } : {}),
      ...(options?.password !== undefined ? { password: options.password } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    return {
      reader: new ZipArchiveReader(reader, Object.keys(openOptions).length > 0 ? openOptions : undefined),
      format: 'zip',
      notes
    };
  }
  if (format === 'tar') {
    const tarOptions: TarReaderOptions = { ...(options?.tar ?? {}) };
    if (options?.profile !== undefined) tarOptions.profile = options.profile;
    if (options?.strict !== undefined) tarOptions.strict = options.strict;
    if (options?.limits !== undefined) tarOptions.limits = options.limits;
    const reader = await TarReader.fromUint8Array(data, tarOptions);
    const auditDefaults: TarAuditOptions = {
      ...(options?.profile !== undefined ? { profile: options.profile } : {}),
      ...(options?.strict !== undefined ? { strict: options.strict } : {}),
      ...(options?.limits !== undefined ? { limits: options.limits } : {})
    };
    return {
      reader: new TarArchiveReader(reader, Object.keys(auditDefaults).length > 0 ? auditDefaults : undefined, 'tar'),
      format: 'tar',
      notes
    };
  }
  if (format === 'gz' || format === 'tgz' || format === 'tar.gz') {
    const header = parseGzipHeader(data);
    const decompressed = await gunzipToBytes(data, options);
    if (format !== 'gz' || detectFormat(decompressed) === 'tar') {
      if (format === 'gz') {
        notes.push('TAR layer detected inside gzip payload');
      }
      const tarOptions: TarReaderOptions = {
        ...(options?.profile !== undefined ? { profile: options.profile } : {}),
        ...(options?.strict !== undefined ? { strict: options.strict } : {}),
        ...(options?.limits !== undefined ? { limits: options.limits } : {})
      };
      const tarReader = await TarReader.fromUint8Array(decompressed, tarOptions);
      const auditDefaults: TarAuditOptions = { ...tarOptions };
      return {
        reader: new TarArchiveReader(
          tarReader,
          Object.keys(auditDefaults).length > 0 ? auditDefaults : undefined,
          'tgz'
        ),
        format: 'tgz',
        notes
      };
    }
    return { reader: new GzipArchiveReader(decompressed, header), format: 'gz', notes };
  }
  if (format === 'zst' || format === 'tar.zst') {
    const decompressed = await decompressToBytes(data, 'zstd', options);
    if (format === 'tar.zst' || detectFormat(decompressed) === 'tar') {
      if (format !== 'tar.zst') {
        notes.push('TAR layer detected inside zstd payload');
      }
      const tarOptions: TarReaderOptions = {
        ...(options?.profile !== undefined ? { profile: options.profile } : {}),
        ...(options?.strict !== undefined ? { strict: options.strict } : {}),
        ...(options?.limits !== undefined ? { limits: options.limits } : {})
      };
      const tarReader = await TarReader.fromUint8Array(decompressed, tarOptions);
      const auditDefaults: TarAuditOptions = { ...tarOptions };
      return {
        reader: new TarArchiveReader(
          tarReader,
          Object.keys(auditDefaults).length > 0 ? auditDefaults : undefined,
          'tar.zst'
        ),
        format: 'tar.zst',
        notes
      };
    }
    return { reader: new CompressedArchiveReader(decompressed, 'zstd'), format: 'zst', notes };
  }
  if (format === 'br' || format === 'tar.br') {
    const decompressed = await decompressToBytes(data, 'brotli', options);
    if (format === 'tar.br' || detectFormat(decompressed) === 'tar') {
      if (format !== 'tar.br') {
        notes.push('TAR layer detected inside brotli payload');
      }
      const tarOptions: TarReaderOptions = {
        ...(options?.profile !== undefined ? { profile: options.profile } : {}),
        ...(options?.strict !== undefined ? { strict: options.strict } : {}),
        ...(options?.limits !== undefined ? { limits: options.limits } : {})
      };
      const tarReader = await TarReader.fromUint8Array(decompressed, tarOptions);
      const auditDefaults: TarAuditOptions = { ...tarOptions };
      return {
        reader: new TarArchiveReader(
          tarReader,
          Object.keys(auditDefaults).length > 0 ? auditDefaults : undefined,
          'tar.br'
        ),
        format: 'tar.br',
        notes
      };
    }
    return { reader: new CompressedArchiveReader(decompressed, 'brotli'), format: 'br', notes };
  }
  if (format === 'bz2' || format === 'tar.bz2') {
    const decompressed = await decompressToBytes(data, 'bzip2', options);
    if (format === 'tar.bz2' || detectFormat(decompressed) === 'tar') {
      if (format !== 'tar.bz2') {
        notes.push('TAR layer detected inside bzip2 payload');
      }
      const tarOptions: TarReaderOptions = {
        ...(options?.profile !== undefined ? { profile: options.profile } : {}),
        ...(options?.strict !== undefined ? { strict: options.strict } : {}),
        ...(options?.limits !== undefined ? { limits: options.limits } : {})
      };
      const tarReader = await TarReader.fromUint8Array(decompressed, tarOptions);
      const auditDefaults: TarAuditOptions = { ...tarOptions };
      return {
        reader: new TarArchiveReader(
          tarReader,
          Object.keys(auditDefaults).length > 0 ? auditDefaults : undefined,
          'tar.bz2'
        ),
        format: 'tar.bz2',
        notes
      };
    }
    const name = inferBzip2EntryName(options?.filename);
    return { reader: new CompressedArchiveReader(decompressed, 'bzip2', name), format: 'bz2', notes };
  }
  if (format === 'xz' || format === 'tar.xz') {
    throw new ArchiveError('ARCHIVE_UNSUPPORTED_FORMAT', 'XZ compression detected but is not supported');
  }

  throw new ArchiveError('ARCHIVE_UNSUPPORTED_FORMAT', `Unsupported format: ${format}`);
}

async function resolveInput(input: ArchiveInput, options?: ArchiveOpenOptions): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  const readOptions: { signal?: AbortSignal; maxBytes?: bigint | number } = {};
  if (options?.signal) readOptions.signal = options.signal;
  if (options?.limits?.maxTotalUncompressedBytes !== undefined) {
    readOptions.maxBytes = options.limits.maxTotalUncompressedBytes;
  }
  return readAllBytes(input, readOptions);
}

function detectFormat(data: Uint8Array): ArchiveFormat | undefined {
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    return 'gz';
  }
  if (data.length >= 4 && data[0] === 0x42 && data[1] === 0x5a && data[2] === 0x68) {
    const level = data[3] ?? 0;
    if (level >= 0x31 && level <= 0x39) return 'bz2';
  }
  if (data.length >= 4 && isZstdHeader(data)) {
    return 'zst';
  }
  if (data.length >= 6 && isXzHeader(data)) {
    return 'xz';
  }
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b) {
    const sig = ((data[2] ?? 0) << 8) | (data[3] ?? 0);
    if (sig === 0x0304 || sig === 0x0506 || sig === 0x0708) {
      return 'zip';
    }
  }
  if (data.length >= 512 && isTarHeader(data.subarray(0, 512))) {
    return 'tar';
  }
  return undefined;
}

function formatFromFilename(filename?: string): ArchiveFormat | undefined {
  if (!filename) return undefined;
  const lower = filename.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tgz';
  if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2') || lower.endsWith('.tbz')) return 'tar.bz2';
  if (lower.endsWith('.tar.zst') || lower.endsWith('.tzst')) return 'tar.zst';
  if (lower.endsWith('.tar.br') || lower.endsWith('.tbr')) return 'tar.br';
  if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) return 'tar.xz';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.gz')) return 'gz';
  if (lower.endsWith('.bz2')) return 'bz2';
  if (lower.endsWith('.bz')) return 'bz2';
  if (lower.endsWith('.zst')) return 'zst';
  if (lower.endsWith('.br')) return 'br';
  if (lower.endsWith('.xz')) return 'xz';
  return undefined;
}

function inferBzip2EntryName(filename?: string): string {
  if (!filename) return 'data';
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const lower = base.toLowerCase();
  if (lower.endsWith('.tar.bz2')) {
    const stem = base.slice(0, -8);
    return stem ? `${stem}.tar` : 'data';
  }
  if (lower.endsWith('.tbz2')) {
    const stem = base.slice(0, -5);
    return stem ? `${stem}.tar` : 'data';
  }
  if (lower.endsWith('.tbz')) {
    const stem = base.slice(0, -4);
    return stem ? `${stem}.tar` : 'data';
  }
  if (lower.endsWith('.bz2')) {
    const stem = base.slice(0, -4);
    return stem || 'data';
  }
  if (lower.endsWith('.bz')) {
    const stem = base.slice(0, -3);
    return stem || 'data';
  }
  return 'data';
}

function resolveInputKind(input: ArchiveInput, hint?: ArchiveInputKind): ArchiveInputKind {
  if (hint) return hint;
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) return 'bytes';
  return 'stream';
}

function buildDetectionReport(
  inputKind: ArchiveInputKind,
  format: ArchiveFormat,
  confidence: ArchiveDetectionReport['confidence'],
  notes: string[]
): ArchiveDetectionReport {
  const detected: ArchiveDetectionReport['detected'] = { layers: [] };
  switch (format) {
    case 'zip':
      detected.container = 'zip';
      detected.compression = 'none';
      detected.layers = ['zip'];
      break;
    case 'tar':
      detected.container = 'tar';
      detected.compression = 'none';
      detected.layers = ['tar'];
      break;
    case 'gz':
      detected.compression = 'gzip';
      detected.layers = ['gzip'];
      break;
    case 'tgz':
    case 'tar.gz':
      detected.container = 'tar';
      detected.compression = 'gzip';
      detected.layers = ['gzip', 'tar'];
      break;
    case 'zst':
      detected.compression = 'zstd';
      detected.layers = ['zstd'];
      break;
    case 'br':
      detected.compression = 'brotli';
      detected.layers = ['brotli'];
      break;
    case 'tar.zst':
      detected.container = 'tar';
      detected.compression = 'zstd';
      detected.layers = ['zstd', 'tar'];
      break;
    case 'tar.br':
      detected.container = 'tar';
      detected.compression = 'brotli';
      detected.layers = ['brotli', 'tar'];
      break;
    case 'bz2':
      detected.compression = 'bzip2';
      detected.layers = ['bzip2'];
      break;
    case 'tar.bz2':
      detected.container = 'tar';
      detected.compression = 'bzip2';
      detected.layers = ['bzip2', 'tar'];
      break;
    case 'xz':
      detected.compression = 'xz';
      detected.layers = ['xz'];
      break;
    case 'tar.xz':
      detected.container = 'tar';
      detected.compression = 'xz';
      detected.layers = ['xz', 'tar'];
      break;
    default:
      detected.layers = [];
  }
  return {
    schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
    inputKind,
    detected,
    confidence,
    notes
  };
}

const ZSTD_MAGIC = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]);
const XZ_MAGIC = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);

function isZstdHeader(data: Uint8Array): boolean {
  if (data.length < ZSTD_MAGIC.length) return false;
  for (let i = 0; i < ZSTD_MAGIC.length; i += 1) {
    if (data[i] !== ZSTD_MAGIC[i]) return false;
  }
  return true;
}

function isXzHeader(data: Uint8Array): boolean {
  if (data.length < XZ_MAGIC.length) return false;
  for (let i = 0; i < XZ_MAGIC.length; i += 1) {
    if (data[i] !== XZ_MAGIC[i]) return false;
  }
  return true;
}

function isTarHeader(block: Uint8Array): boolean {
  const checksumStored = parseOctal(block.subarray(148, 156));
  const checksumActual = computeChecksum(block);
  if (checksumStored !== undefined && checksumStored !== checksumActual) return false;
  const magic = readString(block, 257, 6);
  return magic === 'ustar' || magic === 'ustar\0' || magic === '';
}

function readString(buffer: Uint8Array, start: number, length: number): string {
  let end = start;
  for (; end < start + length; end += 1) {
    if (buffer[end] === 0) break;
  }
  return new TextDecoder('utf-8').decode(buffer.subarray(start, end)).trim();
}

function parseOctal(buffer: Uint8Array): number | undefined {
  const text = new TextDecoder('utf-8').decode(buffer).replace(/\0.*$/, '').trim();
  if (!text) return undefined;
  const value = parseInt(text, 8);
  return Number.isFinite(value) ? value : undefined;
}

function computeChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < header.length; i += 1) {
    if (i >= 148 && i < 156) sum += 0x20;
    else sum += header[i]!;
  }
  return sum;
}

async function gunzipToBytes(data: Uint8Array, options?: ArchiveOpenOptions): Promise<Uint8Array> {
  return decompressToBytes(data, 'gzip', options);
}

async function decompressToBytes(
  data: Uint8Array,
  algorithm: CompressionAlgorithm,
  options?: ArchiveOpenOptions
): Promise<Uint8Array> {
  const transform = await createDecompressTransform({
    algorithm,
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.limits?.maxTotalUncompressedBytes !== undefined
      ? { maxOutputBytes: options.limits.maxTotalUncompressedBytes }
      : {}),
    ...(options?.limits?.maxCompressionRatio !== undefined
      ? { maxCompressionRatio: options.limits.maxCompressionRatio }
      : {})
  });
  const stream = readableFromBytes(data).pipeThrough(transform);
  const readOptions: { signal?: AbortSignal; maxBytes?: bigint | number } = {};
  if (options?.signal) readOptions.signal = options.signal;
  if (options?.limits?.maxTotalUncompressedBytes !== undefined) {
    readOptions.maxBytes = options.limits.maxTotalUncompressedBytes;
  }
  return readAllBytes(stream, readOptions);
}

type GzipHeader = { name?: string; mtime?: Date };

function parseGzipHeader(data: Uint8Array): GzipHeader {
  if (data.length < 10) return {};
  const flags = data[3]!;
  const mtime = readUint32LE(data, 4);
  let offset = 10;
  if (flags & 0x04) {
    if (offset + 2 > data.length) return {};
    const xlen = data[offset]! | (data[offset + 1]! << 8);
    offset += 2 + xlen;
  }
  let name: string | undefined;
  if (flags & 0x08) {
    const start = offset;
    while (offset < data.length && data[offset] !== 0) offset += 1;
    name = decodeLatin1(data.subarray(start, offset));
    offset += 1;
  }
  if (flags & 0x10) {
    while (offset < data.length && data[offset] !== 0) offset += 1;
    offset += 1;
  }
  const header: GzipHeader = {};
  if (name !== undefined) header.name = name;
  if (mtime) header.mtime = new Date(mtime * 1000);
  return header;
}

function decodeLatin1(bytes: Uint8Array): string {
  try {
    return new TextDecoder('latin1').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function readUint32LE(data: Uint8Array, offset: number): number {
  return (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
}

class ZipArchiveReader implements ArchiveReader {
  format: ArchiveFormat = 'zip';
  constructor(private readonly reader: ZipReader, private readonly openOptions?: ZipReaderOpenOptions) {}

  async *entries(): AsyncGenerator<ArchiveEntry> {
    for await (const entry of this.reader.iterEntries()) {
      yield {
        format: 'zip',
        name: entry.name,
        size: entry.uncompressedSize,
        isDirectory: entry.isDirectory,
        isSymlink: entry.isSymlink,
        mtime: entry.mtime,
        open: () => this.reader.open(entry, this.openOptions),
        raw: entry
      };
    }
  }

  async audit(options?: ArchiveAuditOptions): Promise<ArchiveAuditReport> {
    const profile = options?.profile;
    const zipOptions: ZipAuditOptions = {
      ...(profile !== undefined ? { profile: profile as ZipProfile } : {}),
      ...(options?.strict !== undefined ? { strict: options.strict } : {}),
      ...(options?.limits !== undefined ? { limits: options.limits } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    const report = await this.reader.audit(zipOptions);
    const archiveReport: ArchiveAuditReport = {
      schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
      ok: report.ok,
      summary: {
        entries: report.summary.entries,
        warnings: report.summary.warnings,
        errors: report.summary.errors,
        ...(report.summary.trailingBytes !== undefined ? { totalBytes: report.summary.trailingBytes } : {})
      },
      issues: report.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        ...(issue.entryName ? { entryName: issue.entryName } : {}),
        ...(issue.offset !== undefined ? { offset: issue.offset.toString() } : {}),
        ...(issue.details ? { details: sanitizeDetails(issue.details) as Record<string, unknown> } : {})
      }))
    };
    archiveReport.toJSON = () => ({
      schemaVersion: archiveReport.schemaVersion,
      ok: archiveReport.ok,
      summary: archiveReport.summary,
      issues: archiveReport.issues
    });
    return archiveReport;
  }

  async assertSafe(options?: ArchiveAuditOptions): Promise<void> {
    const profile = options?.profile;
    const auditOptions: ZipAuditOptions = {
      ...(profile !== undefined ? { profile: profile as ZipProfile } : {}),
      ...(options?.strict !== undefined ? { strict: options.strict } : {}),
      ...(options?.limits !== undefined ? { limits: options.limits } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    await this.reader.assertSafe(auditOptions);
  }

  async normalizeToWritable(
    writable: WritableStream<Uint8Array>,
    options?: ArchiveNormalizeOptions
  ): Promise<ArchiveNormalizeReport> {
    const normalizeOptions = {
      ...(options?.deterministic !== undefined ? { deterministic: options.deterministic } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    const report = await this.reader.normalizeToWritable(writable, normalizeOptions);
    const archiveReport: ArchiveNormalizeReport = {
      schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
      ok: report.ok,
      summary: {
        entries: report.summary.entries,
        outputEntries: report.summary.outputEntries,
        droppedEntries: report.summary.droppedEntries,
        renamedEntries: report.summary.renamedEntries,
        warnings: report.summary.warnings,
        errors: report.summary.errors
      },
      issues: report.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        ...(issue.entryName ? { entryName: issue.entryName } : {}),
        ...(issue.offset !== undefined ? { offset: issue.offset.toString() } : {}),
        ...(issue.details ? { details: sanitizeDetails(issue.details) as Record<string, unknown> } : {})
      }))
    };
    archiveReport.toJSON = () => ({
      schemaVersion: archiveReport.schemaVersion,
      ok: archiveReport.ok,
      summary: archiveReport.summary,
      issues: archiveReport.issues
    });
    return archiveReport;
  }
}

class TarArchiveReader implements ArchiveReader {
  constructor(
    private readonly reader: TarReader,
    private readonly auditDefaults?: TarAuditOptions,
    public format: ArchiveFormat = 'tar'
  ) {}

  async *entries(): AsyncGenerator<ArchiveEntry> {
    for await (const entry of this.reader.iterEntries()) {
      const archiveEntry: ArchiveEntry = {
        format: this.format,
        name: entry.name,
        size: entry.size,
        isDirectory: entry.isDirectory,
        isSymlink: entry.isSymlink,
        open: () => this.reader.open(entry),
        raw: entry
      };
      if (entry.mtime) archiveEntry.mtime = entry.mtime;
      if (entry.mode !== undefined) archiveEntry.mode = entry.mode;
      if (entry.uid !== undefined) archiveEntry.uid = entry.uid;
      if (entry.gid !== undefined) archiveEntry.gid = entry.gid;
      if (entry.linkName !== undefined) archiveEntry.linkName = entry.linkName;
      yield archiveEntry;
    }
  }

  async audit(options?: ArchiveAuditOptions): Promise<ArchiveAuditReport> {
    const profile = options?.profile ?? this.auditDefaults?.profile;
    const strict = options?.strict ?? this.auditDefaults?.strict;
    const limits = options?.limits ?? this.auditDefaults?.limits;
    const tarOptions: TarAuditOptions = {
      ...(profile !== undefined ? { profile } : {}),
      ...(strict !== undefined ? { strict } : {}),
      ...(limits !== undefined ? { limits } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    const report = await this.reader.audit(tarOptions);
    return report;
  }

  async assertSafe(options?: ArchiveAuditOptions): Promise<void> {
    const profile = options?.profile ?? this.auditDefaults?.profile;
    const strict = options?.strict ?? this.auditDefaults?.strict;
    const limits = options?.limits ?? this.auditDefaults?.limits;
    const tarOptions: TarAuditOptions = {
      ...(profile !== undefined ? { profile } : {}),
      ...(strict !== undefined ? { strict } : {}),
      ...(limits !== undefined ? { limits } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    await this.reader.assertSafe(tarOptions);
  }

  async normalizeToWritable(
    writable: WritableStream<Uint8Array>,
    options?: ArchiveNormalizeOptions
  ): Promise<ArchiveNormalizeReport> {
    const tarOptions: TarNormalizeOptions = {
      ...(options?.deterministic !== undefined ? { deterministic: options.deterministic } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    return this.reader.normalizeToWritable(writable, tarOptions);
  }
}

class GzipArchiveReader implements ArchiveReader {
  format: ArchiveFormat = 'gz';
  private readonly entry: ArchiveEntry;

  constructor(private readonly data: Uint8Array, header: GzipHeader) {
    const entry: ArchiveEntry = {
      format: 'gz',
      name: header.name ?? 'data',
      size: BigInt(data.length),
      isDirectory: false,
      isSymlink: false,
      open: async () => readableFromBytes(this.data)
    };
    if (header.mtime) entry.mtime = header.mtime;
    this.entry = entry;
  }

  async *entries(): AsyncGenerator<ArchiveEntry> {
    yield this.entry;
  }

  async audit(options?: ArchiveAuditOptions): Promise<ArchiveAuditReport> {
    const issues: ArchiveAuditReport['issues'] = [];
    const summary: ArchiveAuditReport['summary'] = {
      entries: 1,
      warnings: 0,
      errors: 0
    };
    const totalBytes = this.entry.size > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(this.entry.size);
    if (totalBytes !== undefined) summary.totalBytes = totalBytes;
    if (options?.limits?.maxTotalUncompressedBytes && this.entry.size > BigInt(options.limits.maxTotalUncompressedBytes)) {
      issues.push({
        code: 'GZIP_LIMIT_EXCEEDED',
        severity: 'error',
        message: 'Uncompressed size exceeds limit',
        entryName: this.entry.name
      });
      summary.errors += 1;
    }
    const pathIssues = entryPathIssues(this.entry.name);
    for (const issue of pathIssues) {
      issues.push(issue);
      if (issue.severity === 'warning') summary.warnings += 1;
      if (issue.severity === 'error') summary.errors += 1;
    }
    return {
      schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
      ok: summary.errors === 0,
      summary,
      issues,
      toJSON: () => ({ schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION, ok: summary.errors === 0, summary, issues })
    };
  }

  async assertSafe(options?: ArchiveAuditOptions): Promise<void> {
    const report = await this.audit(options);
    if (!report.ok) {
      throw new ArchiveError('ARCHIVE_AUDIT_FAILED', 'GZIP audit failed');
    }
  }
}

class CompressedArchiveReader implements ArchiveReader {
  format: ArchiveFormat;
  private readonly entry: ArchiveEntry;
  private readonly algorithm: 'zstd' | 'brotli' | 'bzip2';

  constructor(private readonly data: Uint8Array, algorithm: 'zstd' | 'brotli' | 'bzip2', name = 'data') {
    this.algorithm = algorithm;
    this.format = algorithm === 'zstd' ? 'zst' : algorithm === 'brotli' ? 'br' : 'bz2';
    this.entry = {
      format: this.format,
      name,
      size: BigInt(data.length),
      isDirectory: false,
      isSymlink: false,
      open: async () => readableFromBytes(this.data)
    };
  }

  async *entries(): AsyncGenerator<ArchiveEntry> {
    yield this.entry;
  }

  async audit(options?: ArchiveAuditOptions): Promise<ArchiveAuditReport> {
    const issues: ArchiveAuditReport['issues'] = [];
    const summary: ArchiveAuditReport['summary'] = {
      entries: 1,
      warnings: 0,
      errors: 0
    };
    const totalBytes = this.entry.size > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(this.entry.size);
    if (totalBytes !== undefined) summary.totalBytes = totalBytes;

    if (options?.limits?.maxTotalUncompressedBytes && this.entry.size > BigInt(options.limits.maxTotalUncompressedBytes)) {
      const code =
        this.algorithm === 'zstd'
          ? 'ZSTD_LIMIT_EXCEEDED'
          : this.algorithm === 'brotli'
            ? 'BROTLI_LIMIT_EXCEEDED'
            : 'BZIP2_LIMIT_EXCEEDED';
      issues.push({
        code,
        severity: 'error',
        message: 'Uncompressed size exceeds limit',
        entryName: this.entry.name
      });
      summary.errors += 1;
    }

    const pathIssues = entryPathIssues(this.entry.name);
    for (const issue of pathIssues) {
      issues.push(issue);
      if (issue.severity === 'warning') summary.warnings += 1;
      if (issue.severity === 'error') summary.errors += 1;
    }

    return {
      schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
      ok: summary.errors === 0,
      summary,
      issues,
      toJSON: () => ({ schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION, ok: summary.errors === 0, summary, issues })
    };
  }

  async assertSafe(options?: ArchiveAuditOptions): Promise<void> {
    const report = await this.audit(options);
    if (!report.ok) {
      throw new ArchiveError('ARCHIVE_AUDIT_FAILED', 'Compressed audit failed');
    }
  }
}

function sanitizeDetails(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(sanitizeDetails);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeDetails(val);
    }
    return out;
  }
  return value;
}

function entryPathIssues(entryName: string): ArchiveAuditReport['issues'] {
  const issues: ArchiveAuditReport['issues'] = [];
  if (entryName.includes('\u0000')) {
    issues.push({
      code: 'ARCHIVE_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Entry name contains NUL byte',
      entryName
    });
    return issues;
  }
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    issues.push({
      code: 'ARCHIVE_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Absolute paths are not allowed',
      entryName
    });
  }
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.some((part) => part === '..')) {
    issues.push({
      code: 'ARCHIVE_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Path traversal detected',
      entryName
    });
  }
  return issues;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof (value as ReadableStream<Uint8Array>).getReader === 'function';
}
