import { ArchiveError } from './errors.js';
import type {
  ArchiveAuditReport,
  ArchiveDetectionReport,
  ArchiveEntry,
  ArchiveFormat,
  ArchiveInputKind,
  ArchiveIssueSeverity,
  ArchiveLimits,
  ArchiveNormalizeReport,
  ArchiveOpenOptions,
  ArchiveProfile
} from './types.js';
import { throwIfAborted } from '../abort.js';
import { readAllBytes } from '../streams/buffer.js';
import { readableFromAsyncIterable, readableFromBytes } from '../streams/web.js';
import { createCompressTransform } from '../compression/streams.js';
import { readBzip2BlockSize } from '../compression/bzip2.js';
import { scanXzResourceRequirements } from '../compression/xzScan.js';
import { createDecompressor, getCompressionCapabilities } from '../compress/index.js';
import { CompressionError } from '../compress/errors.js';
import { crc32 } from '../crc32.js';
import { BlobRandomAccess } from '../reader/RandomAccess.js';
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
import { DEFAULT_RESOURCE_LIMITS } from '../limits.js';
import { resolveXzDictionaryLimit, resolveXzIndexLimits } from './xzPreflight.js';
import { isZipSignature, preflightZip, resolveZipPreflightLimits, shouldPreflightZip } from './zipPreflight.js';
import { decodeNullTerminatedUtf8 } from '../binary.js';

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

type PreflightResourceInfo = {
  algorithm: 'bzip2' | 'xz';
  requiredBlockSize?: number;
  requiredDictionaryBytes?: number;
  requiredIndexRecords?: number;
  requiredIndexBytes?: number;
  preflightComplete?: boolean;
  preflightBlockHeaders?: number;
  preflightBlockLimit?: number;
};

type ZipDetectionInfo = {
  inputKind: ArchiveInputKind;
  confidence: ArchiveDetectionReport['confidence'];
  notes: string[];
};

type ArchiveOpenOptionsInternal = ArchiveOpenOptions & {
  __preflight?: PreflightResourceInfo;
  __zipReader?: ZipReader;
  __zipDetection?: ZipDetectionInfo;
};

/** Options for auditing archives opened via openArchive(). */
export type ArchiveAuditOptions = {
  profile?: ArchiveProfile;
  isStrict?: boolean;
  limits?: ArchiveLimits;
  signal?: AbortSignal;
};

/** Options for normalization via openArchive(). */
export type ArchiveNormalizeOptions = {
  isDeterministic?: boolean;
  limits?: ArchiveLimits;
  signal?: AbortSignal;
};

/** Inputs accepted by openArchive(). */
export type ArchiveInput = Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | Blob;

/** Open an archive with auto-detection (or a forced format). */
export async function openArchive(input: ArchiveInput, options?: ArchiveOpenOptions): Promise<ArchiveReader> {
  const internal = options as ArchiveOpenOptionsInternal | undefined;
  if (internal?.__zipReader) {
    const detection = internal.__zipDetection;
    const inputKind = detection?.inputKind ?? resolveInputKind(input, options?.inputKind);
    const notes = detection?.notes ?? ['Format inferred from magic bytes'];
    const confidence = detection?.confidence ?? 'high';
    const openOptions: ZipReaderOpenOptions = {
      ...(options?.isStrict !== undefined ? { isStrict: options.isStrict } : {}),
      ...(options?.password !== undefined ? { password: options.password } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    const reader = new ZipArchiveReader(
      internal.__zipReader,
      Object.keys(openOptions).length > 0 ? openOptions : undefined
    );
    reader.detection = buildDetectionReport(inputKind, 'zip', confidence, notes);
    return reader;
  }
  const formatOption = options?.format ?? 'auto';
  if (isBlobInput(input)) {
    const openedZip = await maybeOpenZipFromBlob(input, formatOption, options);
    if (openedZip) return openedZip;
  }
  const inputKind = resolveInputKind(input, options?.inputKind);
  const data = await resolveInput(input, options);
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

async function maybeOpenZipFromBlob(
  input: Blob,
  formatOption: ArchiveFormat | 'auto',
  options?: ArchiveOpenOptions
): Promise<ArchiveReader | undefined> {
  const filename = options?.filename;
  if (shouldPreflightZip(formatOption, filename)) {
    const detection = buildZipDetection(
      'blob',
      formatOption === 'zip' ? 'forced' : 'filename'
    );
    return openZipFromRandomAccess(new BlobRandomAccess(input), detection, options, filename);
  }
  if (formatOption !== 'auto') return undefined;
  const reader = new BlobRandomAccess(input);
  try {
    const signature = await reader.read(0n, 4, options?.signal);
    if (!isZipSignature(signature)) {
      await reader.close();
      return undefined;
    }
    const detection = buildZipDetection('blob', 'magic');
    return openZipFromRandomAccess(reader, detection, options, filename);
  } catch (err) {
    await reader.close().catch(() => {});
    throw err;
  }
}

function buildZipDetection(
  inputKind: ArchiveInputKind,
  source: 'forced' | 'filename' | 'magic'
): ZipDetectionInfo {
  if (source === 'forced') {
    return { inputKind, confidence: 'high', notes: ['Format forced by options.format'] };
  }
  if (source === 'filename') {
    return { inputKind, confidence: 'medium', notes: ['Format inferred from filename'] };
  }
  return { inputKind, confidence: 'high', notes: ['Format inferred from magic bytes'] };
}

function resolveZipStrict(options?: ArchiveOpenOptions): boolean {
  const profile = options?.profile ?? 'strict';
  const strictDefault = profile === 'compat' ? false : true;
  return options?.isStrict ?? strictDefault;
}

function buildZipReaderOptions(options?: ArchiveOpenOptions): ZipReaderOptions {
  const zipOptions: ZipReaderOptions = { ...(options?.zip ?? {}) };
  const profile = options?.profile;
  if (profile !== undefined) zipOptions.profile = profile as ZipProfile;
  if (options?.isStrict !== undefined) zipOptions.isStrict = options.isStrict;
  if (options?.limits !== undefined) zipOptions.limits = options.limits;
  if (options?.password !== undefined) zipOptions.password = options.password;
  return zipOptions;
}

async function openZipFromRandomAccess(
  reader: BlobRandomAccess,
  detection: ZipDetectionInfo,
  options?: ArchiveOpenOptions,
  filename?: string
): Promise<ArchiveReader> {
  try {
    const limits = resolveZipPreflightLimits(options?.limits, options?.profile);
    await preflightZip(reader, {
      strict: resolveZipStrict(options),
      limits,
      ...(options?.signal ? { signal: options.signal } : {})
    });
    const zipOptions = buildZipReaderOptions(options);
    const zipReader = await ZipReader.fromRandomAccess(reader, zipOptions);
    return openArchive(new Uint8Array(0), {
      ...options,
      __zipReader: zipReader,
      __zipDetection: detection,
      ...(options?.inputKind ? {} : { inputKind: detection.inputKind }),
      ...(options?.filename ? {} : filename ? { filename } : {})
    } as ArchiveOpenOptionsInternal);
  } catch (err) {
    await reader.close().catch(() => {});
    throw err;
  }
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
    ensureCompressionWriteSupported('gzip');
    return createCompressedTarWriter(format, 'gzip', writable, options);
  }
  if (format === 'tar.zst') {
    ensureCompressionWriteSupported('zstd');
    return createCompressedTarWriter('tar.zst', 'zstd', writable, options);
  }
  if (format === 'tar.br') {
    ensureCompressionWriteSupported('brotli');
    return createCompressedTarWriter('tar.br', 'brotli', writable, options);
  }
  if (format === 'tar.bz2' || format === 'bz2') {
    throw new ArchiveError('ARCHIVE_UNSUPPORTED_FORMAT', 'BZip2 compression is not supported for writing');
  }
  if (format === 'tar.xz' || format === 'xz') {
    throw new ArchiveError('ARCHIVE_UNSUPPORTED_FORMAT', 'XZ compression is not supported for writing');
  }
  if (format === 'gz') {
    ensureCompressionWriteSupported('gzip');
    return createCompressedStreamWriter('gz', 'gzip', writable, options);
  }
  if (format === 'zst') {
    ensureCompressionWriteSupported('zstd');
    return createCompressedStreamWriter('zst', 'zstd', writable, options);
  }
  if (format === 'br') {
    ensureCompressionWriteSupported('brotli');
    return createCompressedStreamWriter('br', 'brotli', writable, options);
  }
  throw new ArchiveError('ARCHIVE_UNSUPPORTED_FORMAT', `Unsupported writer format: ${format}`);
}

function ensureCompressionWriteSupported(algorithm: CompressionAlgorithm): void {
  const caps = getCompressionCapabilities();
  const support = caps.algorithms[algorithm];
  if (!support || !support.compress) {
    throw new CompressionError(
      'COMPRESSION_UNSUPPORTED_ALGORITHM',
      `Compression algorithm ${algorithm} is not supported in this runtime`,
      { algorithm }
    );
  }
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
  const internalOptions = options as ArchiveOpenOptionsInternal | undefined;
  const notes: string[] = [];
  if (format === 'zip') {
    const zipOptions: ZipReaderOptions = { ...(options?.zip ?? {}) };
    const profile = options?.profile;
    if (profile !== undefined) zipOptions.profile = profile as ZipProfile;
    if (options?.isStrict !== undefined) zipOptions.isStrict = options.isStrict;
    if (options?.limits !== undefined) zipOptions.limits = options.limits;
    if (options?.password !== undefined) zipOptions.password = options.password;
    const reader = await ZipReader.fromUint8Array(data, zipOptions);
    const openOptions: ZipReaderOpenOptions = {
      ...(options?.isStrict !== undefined ? { isStrict: options.isStrict } : {}),
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
    if (options?.isStrict !== undefined) tarOptions.isStrict = options.isStrict;
    if (options?.limits !== undefined) tarOptions.limits = options.limits;
    const reader = await TarReader.fromUint8Array(data, tarOptions);
    const auditDefaults: TarAuditOptions = {
      ...(options?.profile !== undefined ? { profile: options.profile } : {}),
      ...(options?.isStrict !== undefined ? { isStrict: options.isStrict } : {}),
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
        ...(options?.isStrict !== undefined ? { isStrict: options.isStrict } : {}),
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
    const name = inferGzipEntryName(header, options?.filename);
    return { reader: new GzipArchiveReader(decompressed, header, name), format: 'gz', notes };
  }
  if (format === 'zst' || format === 'tar.zst') {
    const decompressed = await decompressToBytes(data, 'zstd', options);
    if (format === 'tar.zst' || detectFormat(decompressed) === 'tar') {
      if (format !== 'tar.zst') {
        notes.push('TAR layer detected inside zstd payload');
      }
      const tarOptions: TarReaderOptions = {
        ...(options?.profile !== undefined ? { profile: options.profile } : {}),
        ...(options?.isStrict !== undefined ? { isStrict: options.isStrict } : {}),
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
    const name = inferZstdEntryName(options?.filename);
    return { reader: new CompressedArchiveReader(decompressed, 'zstd', name), format: 'zst', notes };
  }
  if (format === 'br' || format === 'tar.br') {
    const decompressed = await decompressToBytes(data, 'brotli', options);
    if (format === 'tar.br' || detectFormat(decompressed) === 'tar') {
      if (format !== 'tar.br') {
        notes.push('TAR layer detected inside brotli payload');
      }
      const tarOptions: TarReaderOptions = {
        ...(options?.profile !== undefined ? { profile: options.profile } : {}),
        ...(options?.isStrict !== undefined ? { isStrict: options.isStrict } : {}),
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
    const name = inferBrotliEntryName(options?.filename);
    return { reader: new CompressedArchiveReader(decompressed, 'brotli', name), format: 'br', notes };
  }
  if (format === 'bz2' || format === 'tar.bz2') {
    const preflight: PreflightResourceInfo | undefined = (() => {
      const size = readBzip2BlockSize(data);
      return size !== undefined
        ? {
            algorithm: 'bzip2',
            requiredBlockSize: size,
            preflightComplete: false
          }
        : undefined;
    })();
    enforceResourceLimits(preflight, options?.limits, options?.profile);
    const decompressed = await decompressToBytes(data, 'bzip2', options);
    if (format === 'tar.bz2' || detectFormat(decompressed) === 'tar') {
      if (format !== 'tar.bz2') {
        notes.push('TAR layer detected inside bzip2 payload');
      }
      const tarOptions: TarReaderOptions = {
        ...(options?.profile !== undefined ? { profile: options.profile } : {}),
        ...(options?.isStrict !== undefined ? { isStrict: options.isStrict } : {}),
        ...(options?.limits !== undefined ? { limits: options.limits } : {})
      };
      const tarReader = await TarReader.fromUint8Array(decompressed, tarOptions);
      const auditDefaults: TarAuditOptions = { ...tarOptions };
      return {
        reader: new TarArchiveReader(
          tarReader,
          Object.keys(auditDefaults).length > 0 ? auditDefaults : undefined,
          'tar.bz2',
          preflight
        ),
        format: 'tar.bz2',
        notes
      };
    }
    const name = inferBzip2EntryName(options?.filename);
    return { reader: new CompressedArchiveReader(decompressed, 'bzip2', name, preflight), format: 'bz2', notes };
  }
  if (format === 'xz' || format === 'tar.xz') {
    const profile = options?.profile ?? 'strict';
    const checkType = readXzCheckType(data);
    if (checkType !== undefined && !isSupportedXzCheck(checkType) && profile === 'compat') {
      notes.push(`XZ check type ${formatXzCheck(checkType)} is not verified in compat profile`);
    }
    const seekablePreflight = internalOptions?.__preflight;
    const preflight: PreflightResourceInfo | undefined = (() => {
      const indexLimits = resolveXzIndexLimits(options?.limits, profile);
      const scan = scanXzResourceRequirements(data, {
        ...(options?.signal ? { signal: options.signal } : {}),
        maxIndexBytes: indexLimits.maxIndexBytes,
        maxIndexRecords: indexLimits.maxIndexRecords
      });
      if (scan) {
        const merged: PreflightResourceInfo = {
          algorithm: 'xz',
          requiredDictionaryBytes: scan.maxDictionaryBytes,
          requiredIndexRecords: scan.requiredIndexRecords,
          requiredIndexBytes: scan.requiredIndexBytes
        };
        if (seekablePreflight?.preflightComplete === false) {
          merged.preflightComplete = false;
          if (seekablePreflight.preflightBlockHeaders !== undefined) {
            merged.preflightBlockHeaders = seekablePreflight.preflightBlockHeaders;
          }
          if (seekablePreflight.preflightBlockLimit !== undefined) {
            merged.preflightBlockLimit = seekablePreflight.preflightBlockLimit;
          }
        }
        return merged;
      }
      return seekablePreflight;
    })();
    enforceResourceLimits(preflight, options?.limits, profile);
    const decompressed = await decompressToBytes(data, 'xz', options);
    if (format === 'tar.xz' || detectFormat(decompressed) === 'tar') {
      if (format !== 'tar.xz') {
        notes.push('TAR layer detected inside xz payload');
      }
      const tarOptions: TarReaderOptions = {
        ...(options?.profile !== undefined ? { profile: options.profile } : {}),
        ...(options?.isStrict !== undefined ? { isStrict: options.isStrict } : {}),
        ...(options?.limits !== undefined ? { limits: options.limits } : {})
      };
      const tarReader = await TarReader.fromUint8Array(decompressed, tarOptions);
      const auditDefaults: TarAuditOptions = { ...tarOptions };
      return {
        reader: new TarArchiveReader(
          tarReader,
          Object.keys(auditDefaults).length > 0 ? auditDefaults : undefined,
          'tar.xz',
          preflight
        ),
        format: 'tar.xz',
        notes
      };
    }
    const name = inferXzEntryName(options?.filename);
    return { reader: new CompressedArchiveReader(decompressed, 'xz', name, preflight), format: 'xz', notes };
  }

  throw new ArchiveError('ARCHIVE_UNSUPPORTED_FORMAT', `Unsupported format: ${format}`);
}

async function resolveInput(input: ArchiveInput, options?: ArchiveOpenOptions): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  const maxBytes = resolveInputMaxBytes(options);
  if (isBlobInput(input)) {
    return readBlobBytes(input, {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {})
    });
  }
  const readOptions: { signal?: AbortSignal; maxBytes?: bigint | number } = {};
  if (options?.signal) readOptions.signal = options.signal;
  if (maxBytes !== undefined) readOptions.maxBytes = maxBytes;
  return readAllBytes(input, readOptions);
}

function resolveInputMaxBytes(options?: ArchiveOpenOptions): bigint | number | undefined {
  if (options?.limits?.maxInputBytes !== undefined) {
    return options.limits.maxInputBytes;
  }
  if (options?.limits?.maxTotalDecompressedBytes !== undefined) {
    return options.limits.maxTotalDecompressedBytes;
  }
  if (options?.limits?.maxTotalUncompressedBytes !== undefined) {
    return options.limits.maxTotalUncompressedBytes;
  }
  return undefined;
}

async function readBlobBytes(
  input: Blob,
  options?: { signal?: AbortSignal; maxBytes?: bigint | number }
): Promise<Uint8Array> {
  throwIfAborted(options?.signal);
  if (options?.maxBytes !== undefined && BigInt(input.size) > toBigInt(options.maxBytes)) {
    throw new RangeError('Stream exceeds maximum allowed size');
  }
  const buffer = await input.arrayBuffer();
  throwIfAborted(options?.signal);
  return new Uint8Array(buffer);
}

type ResourceLimitIssue = {
  issue: ArchiveAuditReport['issues'][number];
  context: Record<string, string>;
};

function resolveBzip2BlockLimit(limits?: ArchiveLimits): number {
  const raw = limits?.maxBzip2BlockSize;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(1, Math.min(9, Math.floor(raw)));
  }
  return DEFAULT_RESOURCE_LIMITS.maxBzip2BlockSize;
}

// resolveXzIndexLimits and resolveXzDictionaryLimit live in src/archive/xzPreflight.ts

function resolveResourceLimitIssue(
  preflight: PreflightResourceInfo | undefined,
  limits?: ArchiveLimits,
  profile?: ArchiveProfile
): ResourceLimitIssue | null {
  if (!preflight) return null;
  if (preflight.algorithm === 'bzip2' && preflight.requiredBlockSize !== undefined) {
    const limit = resolveBzip2BlockLimit(limits);
    if (preflight.requiredBlockSize > limit) {
      const context = {
        algorithm: 'bzip2',
        requiredBlockSize: String(preflight.requiredBlockSize),
        limitBlockSize: String(limit)
      };
      return {
        issue: {
          code: 'COMPRESSION_RESOURCE_LIMIT',
          severity: 'error',
          message: `BZip2 block size ${preflight.requiredBlockSize} exceeds limit`,
          details: context
        },
        context
      };
    }
    return null;
  }
  if (preflight.algorithm === 'xz') {
    const indexLimits = resolveXzIndexLimits(limits, profile);
    if (
      preflight.requiredIndexRecords !== undefined &&
      preflight.requiredIndexRecords > indexLimits.maxIndexRecords
    ) {
      const context = {
        algorithm: 'xz',
        requiredIndexRecords: String(preflight.requiredIndexRecords),
        limitIndexRecords: String(indexLimits.maxIndexRecords)
      };
      return {
        issue: {
          code: 'COMPRESSION_RESOURCE_LIMIT',
          severity: 'error',
          message: `XZ index record count ${preflight.requiredIndexRecords} exceeds limit`,
          details: context
        },
        context
      };
    }
    if (preflight.requiredIndexBytes !== undefined && preflight.requiredIndexBytes > indexLimits.maxIndexBytes) {
      const context = {
        algorithm: 'xz',
        requiredIndexBytes: String(preflight.requiredIndexBytes),
        limitIndexBytes: String(indexLimits.maxIndexBytes)
      };
      return {
        issue: {
          code: 'COMPRESSION_RESOURCE_LIMIT',
          severity: 'error',
          message: `XZ index size ${preflight.requiredIndexBytes} exceeds limit`,
          details: context
        },
        context
      };
    }
    if (preflight.requiredDictionaryBytes !== undefined) {
      const limit = resolveXzDictionaryLimit(limits, profile);
      if (BigInt(preflight.requiredDictionaryBytes) > limit) {
        const context = {
          algorithm: 'xz',
          requiredDictionaryBytes: String(preflight.requiredDictionaryBytes),
          limitDictionaryBytes: limit.toString()
        };
        return {
          issue: {
            code: 'COMPRESSION_RESOURCE_LIMIT',
            severity: 'error',
            message: `XZ dictionary size ${preflight.requiredDictionaryBytes} exceeds limit`,
            details: context
          },
          context
        };
      }
    }
  }
  return null;
}

function enforceResourceLimits(
  preflight: PreflightResourceInfo | undefined,
  limits?: ArchiveLimits,
  profile?: ArchiveProfile
): void {
  const violation = resolveResourceLimitIssue(preflight, limits, profile);
  if (!violation || !preflight) return;
  throw new CompressionError('COMPRESSION_RESOURCE_LIMIT', violation.issue.message, {
    algorithm: preflight.algorithm,
    context: violation.context
  });
}

function appendResourceLimitIssue(
  report: ArchiveAuditReport,
  preflight: PreflightResourceInfo | undefined,
  limits?: ArchiveLimits,
  profile?: ArchiveProfile
): ArchiveAuditReport {
  const violation = resolveResourceLimitIssue(preflight, limits, profile);
  if (!violation) return report;
  report.issues.push(violation.issue);
  report.summary.errors += 1;
  report.ok = false;
  return report;
}

function appendResourcePreflightIssue(
  report: ArchiveAuditReport,
  preflight: PreflightResourceInfo | undefined
): ArchiveAuditReport {
  if (!preflight || preflight.preflightComplete !== false) return report;
  const context: Record<string, string> = { algorithm: preflight.algorithm };
  let severity: ArchiveIssueSeverity = 'warning';
  let message = 'Resource preflight is incomplete';
  if (preflight.algorithm === 'bzip2') {
    message = 'Resource preflight does not scan concatenated bzip2 members';
  } else if (preflight.algorithm === 'xz') {
    severity = 'info';
    message = 'Resource preflight did not scan all XZ block headers';
    if (preflight.preflightBlockHeaders !== undefined) {
      context.requiredBlockHeaders = String(preflight.preflightBlockHeaders);
    }
    if (preflight.preflightBlockLimit !== undefined) {
      context.limitBlockHeaders = String(preflight.preflightBlockLimit);
    }
  }
  report.issues.push({
    code: 'COMPRESSION_RESOURCE_PREFLIGHT_INCOMPLETE',
    severity,
    message,
    details: context
  });
  if (severity === 'warning') report.summary.warnings += 1;
  return report;
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

function sanitizeSingleFileName(name?: string): string | undefined {
  if (!name) return undefined;
  if (name.includes('\u0000')) return undefined;
  const base = name.split(/[\\/]/).pop() ?? name;
  const trimmed = base.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return undefined;
  return trimmed;
}

function inferGzipEntryName(header: GzipHeader, filename?: string): string {
  const headerName = sanitizeSingleFileName(header.name);
  if (headerName) return headerName;
  const base = sanitizeSingleFileName(filename);
  if (!base) return 'data';
  const lower = base.toLowerCase();
  if (lower.endsWith('.tar.gz')) {
    const stem = base.slice(0, -7);
    return stem ? `${stem}.tar` : 'data';
  }
  if (lower.endsWith('.tgz')) {
    const stem = base.slice(0, -4);
    return stem ? `${stem}.tar` : 'data';
  }
  if (lower.endsWith('.gz')) {
    const stem = base.slice(0, -3);
    return stem || 'data';
  }
  return 'data';
}

function inferBrotliEntryName(filename?: string): string {
  const base = sanitizeSingleFileName(filename);
  if (!base) return 'data';
  const lower = base.toLowerCase();
  if (lower.endsWith('.tar.br')) {
    const stem = base.slice(0, -7);
    return stem ? `${stem}.tar` : 'data';
  }
  if (lower.endsWith('.tbr')) {
    const stem = base.slice(0, -4);
    return stem ? `${stem}.tar` : 'data';
  }
  if (lower.endsWith('.br')) {
    const stem = base.slice(0, -3);
    return stem || 'data';
  }
  return 'data';
}

function inferZstdEntryName(filename?: string): string {
  const base = sanitizeSingleFileName(filename);
  if (!base) return 'data';
  const lower = base.toLowerCase();
  if (lower.endsWith('.tar.zst')) {
    const stem = base.slice(0, -8);
    return stem ? `${stem}.tar` : 'data';
  }
  if (lower.endsWith('.tzst')) {
    const stem = base.slice(0, -5);
    return stem ? `${stem}.tar` : 'data';
  }
  if (lower.endsWith('.zst')) {
    const stem = base.slice(0, -4);
    return stem || 'data';
  }
  return 'data';
}

function inferBzip2EntryName(filename?: string): string {
  const base = sanitizeSingleFileName(filename);
  if (!base) return 'data';
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

function inferXzEntryName(filename?: string): string {
  const base = sanitizeSingleFileName(filename);
  if (!base) return 'data';
  const lower = base.toLowerCase();
  if (lower.endsWith('.tar.xz')) {
    const stem = base.slice(0, -7);
    return stem ? `${stem}.tar` : 'data';
  }
  if (lower.endsWith('.txz')) {
    const stem = base.slice(0, -4);
    return stem ? `${stem}.tar` : 'data';
  }
  if (lower.endsWith('.xz')) {
    const stem = base.slice(0, -3);
    return stem || 'data';
  }
  return 'data';
}

function resolveInputKind(input: ArchiveInput, hint?: ArchiveInputKind): ArchiveInputKind {
  if (hint) return hint;
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) return 'bytes';
  if (isBlobInput(input)) return 'blob';
  return 'stream';
}

function isBlobInput(input: unknown): input is Blob {
  return typeof Blob !== 'undefined' && input instanceof Blob;
}

function toBigInt(value: bigint | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
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

function readXzCheckType(data: Uint8Array): number | undefined {
  if (!isXzHeader(data) || data.length < 12) return undefined;
  const flags0 = data[6]!;
  const flags1 = data[7]!;
  if (flags0 !== 0x00 || (flags1 & 0xf0) !== 0) return undefined;
  return flags1 & 0x0f;
}

function isSupportedXzCheck(checkType: number): boolean {
  return checkType === 0x00 || checkType === 0x01 || checkType === 0x04;
}

function formatXzCheck(checkType: number): string {
  if (checkType === 0x00) return 'none';
  if (checkType === 0x01) return 'crc32';
  if (checkType === 0x04) return 'crc64';
  if (checkType === 0x0a) return 'sha256';
  return `0x${checkType.toString(16)}`;
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
  const text = decodeNullTerminatedUtf8(buffer).trim();
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
  const limits = options?.limits;
  const transform = createDecompressor({
    algorithm,
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(limits?.maxTotalDecompressedBytes !== undefined
      ? { maxOutputBytes: limits.maxTotalDecompressedBytes }
      : limits?.maxTotalUncompressedBytes !== undefined
        ? { maxOutputBytes: limits.maxTotalUncompressedBytes }
        : {}),
    ...(limits?.maxCompressionRatio !== undefined ? { maxCompressionRatio: limits.maxCompressionRatio } : {}),
    ...(limits?.maxXzDictionaryBytes !== undefined
      ? { maxDictionaryBytes: limits.maxXzDictionaryBytes }
      : limits?.maxDictionaryBytes !== undefined
        ? { maxDictionaryBytes: limits.maxDictionaryBytes }
        : {}),
    ...(limits?.maxXzBufferedBytes !== undefined ? { maxBufferedInputBytes: limits.maxXzBufferedBytes } : {}),
    ...(limits?.maxBzip2BlockSize !== undefined ? { maxBzip2BlockSize: limits.maxBzip2BlockSize } : {}),
    ...(limits ? { limits } : {}),
    ...(options?.profile ? { profile: options.profile } : {})
  });
  const stream = readableFromBytes(data).pipeThrough(transform);
  const readOptions: { signal?: AbortSignal; maxBytes?: bigint | number } = {};
  if (options?.signal) readOptions.signal = options.signal;
  if (limits?.maxTotalDecompressedBytes !== undefined) {
    readOptions.maxBytes = limits.maxTotalDecompressedBytes;
  } else if (limits?.maxTotalUncompressedBytes !== undefined) {
    readOptions.maxBytes = limits.maxTotalUncompressedBytes;
  }
  try {
    return await readAllBytes(stream, readOptions);
  } catch (err) {
    if (err instanceof CompressionError) throw err;
    if (err instanceof RangeError) throw err;
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') throw err;
    throw new CompressionError('COMPRESSION_BACKEND_UNAVAILABLE', 'Compression backend failed', {
      algorithm,
      cause: err
    });
  }
}

type GzipHeader = { name?: string; mtime?: Date };

function parseGzipHeader(data: Uint8Array): GzipHeader {
  if (data.length < 10) return {};
  const flags = data[3]!;
  const mtime = readUint32LE(data, 4);
  let offset = 10;
  if (flags & 0x04) {
    if (offset + 2 > data.length) {
      throw new CompressionError('COMPRESSION_GZIP_BAD_HEADER', 'Gzip header truncated', {
        algorithm: 'gzip'
      });
    }
    const xlen = data[offset]! | (data[offset + 1]! << 8);
    if (offset + 2 + xlen > data.length) {
      throw new CompressionError('COMPRESSION_GZIP_BAD_HEADER', 'Gzip header truncated', {
        algorithm: 'gzip'
      });
    }
    offset += 2 + xlen;
  }
  let name: string | undefined;
  if (flags & 0x08) {
    const start = offset;
    while (offset < data.length && data[offset] !== 0) offset += 1;
    if (offset >= data.length) {
      throw new CompressionError('COMPRESSION_GZIP_BAD_HEADER', 'Gzip header truncated', {
        algorithm: 'gzip'
      });
    }
    name = decodeLatin1(data.subarray(start, offset));
    offset += 1;
  }
  if (flags & 0x10) {
    while (offset < data.length && data[offset] !== 0) offset += 1;
    if (offset >= data.length) {
      throw new CompressionError('COMPRESSION_GZIP_BAD_HEADER', 'Gzip header truncated', {
        algorithm: 'gzip'
      });
    }
    offset += 1;
  }
  if (flags & 0x02) {
    if (offset + 2 > data.length) {
      throw new CompressionError('COMPRESSION_GZIP_BAD_HEADER', 'Gzip header truncated', {
        algorithm: 'gzip'
      });
    }
    const stored = data[offset]! | (data[offset + 1]! << 8);
    const computed = (crc32(data.subarray(0, offset)) ^ 0xffffffff) & 0xffff;
    if (stored !== computed) {
      throw new CompressionError('COMPRESSION_GZIP_BAD_HEADER', 'Gzip header CRC mismatch', {
        algorithm: 'gzip',
        context: { stored: String(stored), expected: String(computed) }
      });
    }
    offset += 2;
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
  detection?: ArchiveDetectionReport;
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
      ...(options?.isStrict !== undefined ? { isStrict: options.isStrict } : {}),
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

  async close(): Promise<void> {
    await this.reader.close();
  }

  async assertSafe(options?: ArchiveAuditOptions): Promise<void> {
    const profile = options?.profile;
    const auditOptions: ZipAuditOptions = {
      ...(profile !== undefined ? { profile: profile as ZipProfile } : {}),
      ...(options?.isStrict !== undefined ? { isStrict: options.isStrict } : {}),
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
      ...(options?.isDeterministic !== undefined ? { isDeterministic: options.isDeterministic } : {}),
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
  detection?: ArchiveDetectionReport;
  constructor(
    private readonly reader: TarReader,
    private readonly auditDefaults?: TarAuditOptions,
    public format: ArchiveFormat = 'tar',
    private readonly preflight?: PreflightResourceInfo
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
    const isStrict = options?.isStrict ?? this.auditDefaults?.isStrict;
    const limits = options?.limits ?? this.auditDefaults?.limits;
    const tarOptions: TarAuditOptions = {
      ...(profile !== undefined ? { profile } : {}),
      ...(isStrict !== undefined ? { isStrict } : {}),
      ...(limits !== undefined ? { limits } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    const report = await this.reader.audit(tarOptions);
    appendResourcePreflightIssue(report, this.preflight);
    return appendResourceLimitIssue(report, this.preflight, limits, profile);
  }

  async assertSafe(options?: ArchiveAuditOptions): Promise<void> {
    const report = await this.audit(options);
    if (!report.ok) {
      throw new ArchiveError('ARCHIVE_AUDIT_FAILED', 'TAR audit failed');
    }
  }

  async normalizeToWritable(
    writable: WritableStream<Uint8Array>,
    options?: ArchiveNormalizeOptions
  ): Promise<ArchiveNormalizeReport> {
    const limits = options?.limits ?? this.auditDefaults?.limits;
    enforceResourceLimits(this.preflight, limits, this.auditDefaults?.profile);
    const tarOptions: TarNormalizeOptions = {
      ...(options?.isDeterministic !== undefined ? { isDeterministic: options.isDeterministic } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.limits !== undefined ? { limits: options.limits } : {})
    };
    return this.reader.normalizeToWritable(writable, tarOptions);
  }
}

class GzipArchiveReader implements ArchiveReader {
  format: ArchiveFormat = 'gz';
  detection?: ArchiveDetectionReport;
  private readonly entry: ArchiveEntry;

  constructor(private readonly data: Uint8Array, header: GzipHeader, name: string) {
    const entry: ArchiveEntry = {
      format: 'gz',
      name,
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
    const maxTotal =
      options?.limits?.maxTotalDecompressedBytes ?? options?.limits?.maxTotalUncompressedBytes;
    if (maxTotal !== undefined && this.entry.size > BigInt(maxTotal)) {
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

  async normalizeToWritable(): Promise<ArchiveNormalizeReport> {
    throw new ArchiveError(
      'ARCHIVE_UNSUPPORTED_FEATURE',
      'Normalization is not supported for single-file compressed formats'
    );
  }
}

class CompressedArchiveReader implements ArchiveReader {
  format: ArchiveFormat;
  detection?: ArchiveDetectionReport;
  private readonly entry: ArchiveEntry;
  private readonly algorithm: 'zstd' | 'brotli' | 'bzip2' | 'xz';
  private readonly preflight: PreflightResourceInfo | undefined;

  constructor(
    private readonly data: Uint8Array,
    algorithm: 'zstd' | 'brotli' | 'bzip2' | 'xz',
    name = 'data',
    preflight?: PreflightResourceInfo
  ) {
    this.algorithm = algorithm;
    this.format = algorithm === 'zstd' ? 'zst' : algorithm === 'brotli' ? 'br' : algorithm === 'xz' ? 'xz' : 'bz2';
    this.preflight = preflight;
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

    const maxTotal =
      options?.limits?.maxTotalDecompressedBytes ?? options?.limits?.maxTotalUncompressedBytes;
    if (maxTotal !== undefined && this.entry.size > BigInt(maxTotal)) {
      const code =
        this.algorithm === 'zstd'
          ? 'ZSTD_LIMIT_EXCEEDED'
          : this.algorithm === 'brotli'
            ? 'BROTLI_LIMIT_EXCEEDED'
            : this.algorithm === 'xz'
              ? 'XZ_LIMIT_EXCEEDED'
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

    const report: ArchiveAuditReport = {
      schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
      ok: summary.errors === 0,
      summary,
      issues,
      toJSON: () => ({ schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION, ok: summary.errors === 0, summary, issues })
    };
    appendResourcePreflightIssue(report, this.preflight);
    return appendResourceLimitIssue(report, this.preflight, options?.limits, options?.profile);
  }

  async assertSafe(options?: ArchiveAuditOptions): Promise<void> {
    const report = await this.audit(options);
    if (!report.ok) {
      throw new ArchiveError('ARCHIVE_AUDIT_FAILED', 'Compressed audit failed');
    }
  }

  async normalizeToWritable(): Promise<ArchiveNormalizeReport> {
    throw new ArchiveError(
      'ARCHIVE_UNSUPPORTED_FEATURE',
      'Normalization is not supported for single-file compressed formats'
    );
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
