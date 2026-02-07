import type { ArchiveDetectionReport, ArchiveInputKind, ArchiveOpenOptions } from '../archive/types.js';
import { openArchive as openArchiveCore, type ArchiveReader } from '../archive/index.js';
import { CompressionError } from '../compress/errors.js';
import { ArchiveError } from '../archive/errors.js';
import { ZipError } from '../errors.js';
import { preflightXzIndexLimits } from '../compression/xzIndexPreflight.js';
import { HttpRandomAccess, type RandomAccess } from '../reader/RandomAccess.js';
import { mapHttpErrorToZipError, wrapRandomAccessForZip } from '../reader/httpZipErrors.js';
import { mapHttpErrorToArchiveError } from '../archive/httpArchiveErrors.js';
import { resolveXzDictionaryLimit, resolveXzPreflightLimits, shouldPreflightXz } from '../archive/xzPreflight.js';
import { isZipSignature, preflightZip, resolveZipPreflightLimits, shouldPreflightZip } from '../archive/zipPreflight.js';
import { mergeSignals, throwIfAborted } from '../abort.js';
import { ZipReader } from '../reader/ZipReader.js';
import { ZipWriter } from '../writer/ZipWriter.js';
import { TarReader } from '../tar/TarReader.js';
import { TarWriter } from '../tar/TarWriter.js';
import type { ZipProfile, ZipReaderOptions } from '../types.js';

type BunFile = { arrayBuffer: () => Promise<ArrayBuffer>; size?: number; slice?: (start: number, end?: number) => BunFile };
type BunApi = {
  file: (path: string) => BunFile;
  write: (path: string, data: Uint8Array) => Promise<unknown> | unknown;
};

export { ArchiveError } from '../archive/errors.js';
export type {
  ArchiveAuditReport,
  ArchiveDetectionReport,
  ArchiveEntry,
  ArchiveFormat,
  ArchiveInputKind,
  ArchiveIssue,
  ArchiveIssueSeverity,
  ArchiveLimits,
  ArchiveNormalizeReport,
  ArchiveOpenOptions,
  ArchiveProfile
} from '../archive/types.js';
export type { ArchiveReader, ArchiveWriter } from '../archive/index.js';
export { createArchiveWriter } from '../archive/index.js';

export * from '../zip/index.js';
export * from '../tar/index.js';

const BunGlobal = (globalThis as { Bun?: BunApi }).Bun;

function requireBun(): BunApi {
  if (!BunGlobal) {
    throw new Error('Bun global is not available in this runtime.');
  }
  return BunGlobal;
}

export type BunArchiveInput = Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array> | string | URL;

type XzPreflightInfo = {
  algorithm: 'xz';
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
  __preflight?: XzPreflightInfo;
  __zipReader?: ZipReader;
  __zipDetection?: ZipDetectionInfo;
};

export async function openArchive(input: BunArchiveInput, options?: ArchiveOpenOptions): Promise<ArchiveReader> {
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    return openArchiveCore(input, {
      ...options,
      ...(options?.inputKind ? {} : { inputKind: 'bytes' })
    });
  }
  if (isBlobInput(input)) {
    return openArchiveCore(input, {
      ...options,
      ...(options?.inputKind ? {} : { inputKind: 'blob' })
    });
  }
  if (typeof input === 'string' || input instanceof URL) {
    const isHttp = isHttpUrl(input);
    const path = typeof input === 'string' ? input : input.toString();
    const filename = options?.filename ?? (isHttp ? inferFilenameFromUrl(path) : path);
    const formatOption = options?.format ?? 'auto';
    if (isHttp) {
      if (shouldPreflightZip(formatOption, filename)) {
        const detection = buildZipDetection(
          'url',
          formatOption === 'zip' ? 'forced' : 'filename'
        );
        const reader = wrapRandomAccessForZip(
          new HttpRandomAccess(path, resolveZipHttpOptions(options, { blockSize: 32 * 1024, maxBlocks: 4 }))
        );
        return openZipFromRandomAccess(reader, detection, options, filename);
      }
      if (formatOption === 'auto') {
        const reader = wrapRandomAccessForZip(
          new HttpRandomAccess(path, resolveZipHttpOptions(options, { blockSize: 32 * 1024, maxBlocks: 4 }))
        );
        try {
          const signature = await reader.read(0n, 4, options?.signal);
          if (isZipSignature(signature)) {
            const detection = buildZipDetection('url', 'magic');
            return openZipFromRandomAccess(reader, detection, options, filename);
          }
        } catch (err) {
          await reader.close().catch(() => {});
          const mapped = mapHttpErrorToZipError(err);
          if (!(mapped instanceof ZipError && mapped.code === 'ZIP_HTTP_RANGE_UNSUPPORTED')) {
            throw mapped;
          }
        }
        await reader.close();
      }
      const preflight = await preflightSeekableXzHttp(path, filename, options);
      const response = await fetch(path, options?.signal ? { signal: options.signal } : undefined);
      if (!response.ok) {
        throw new ArchiveError('ARCHIVE_BAD_HEADER', `Unexpected HTTP status ${response.status}`);
      }
      const data = new Uint8Array(await response.arrayBuffer());
      return openArchiveCore(data, {
        ...options,
        ...(preflight ? { __preflight: preflight } : {}),
        ...(options?.inputKind ? {} : { inputKind: 'url' }),
        ...(options?.filename ? {} : { filename })
      } as ArchiveOpenOptionsInternal);
    }
    if (shouldPreflightZip(formatOption, filename)) {
      const detection = buildZipDetection(
        input instanceof URL ? 'url' : 'file',
        formatOption === 'zip' ? 'forced' : 'filename'
      );
      const reader = await BunFileRandomAccess.fromPath(path);
      return openZipFromRandomAccess(reader, detection, options, path);
    }
    if (formatOption === 'auto') {
      const reader = await BunFileRandomAccess.fromPath(path);
      try {
        const signature = await reader.read(0n, 4, options?.signal);
        if (isZipSignature(signature)) {
          const detection = buildZipDetection(input instanceof URL ? 'url' : 'file', 'magic');
          return openZipFromRandomAccess(reader, detection, options, path);
        }
      } catch (err) {
        await reader.close().catch(() => {});
        throw err;
      }
      await reader.close();
    }
    const preflight = await preflightSeekableXzFile(path, filename, options);
    const data = new Uint8Array(await requireBun().file(path).arrayBuffer());
    return openArchiveCore(data, {
      ...options,
      ...(preflight ? { __preflight: preflight } : {}),
      ...(options?.inputKind ? {} : { inputKind: input instanceof URL ? 'url' : 'file' }),
      ...(options?.filename ? {} : { filename: path })
    } as ArchiveOpenOptionsInternal);
  }
  return openArchiveCore(input, {
    ...options,
    ...(options?.inputKind ? {} : { inputKind: 'stream' })
  });
}

export async function zipFromFile(
  path: string,
  options?: Parameters<typeof ZipReader.fromRandomAccess>[1]
): Promise<ZipReader> {
  const reader = await BunFileRandomAccess.fromPath(path);
  try {
    return await ZipReader.fromRandomAccess(reader, options);
  } catch (err) {
    await reader.close().catch(() => {});
    throw err;
  }
}

export async function tarFromFile(
  path: string,
  options?: Parameters<typeof TarReader.fromUint8Array>[1]
): Promise<TarReader> {
  const data = new Uint8Array(await requireBun().file(path).arrayBuffer());
  return TarReader.fromUint8Array(data, options);
}

export async function zipToFile(
  path: string,
  options?: Parameters<typeof ZipWriter.toWritable>[1]
): Promise<ZipWriter> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = ZipWriter.toWritable(writable, options);
  const close = writer.close.bind(writer);
  writer.close = async (...args: Parameters<typeof close>) => {
    await close(...args);
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    await requireBun().write(path, out);
  };
  return writer;
}

function isHttpUrl(value: string | URL): boolean {
  const url = typeof value === 'string' ? safeParseUrl(value) : value;
  if (!url) return false;
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function isBlobInput(input: unknown): input is Blob {
  return typeof Blob !== 'undefined' && input instanceof Blob;
}

function safeParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function inferFilenameFromUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname || value;
  } catch {
    return value;
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

function resolveZipHttpOptions(
  options?: ArchiveOpenOptions,
  defaults?: { blockSize: number; maxBlocks: number }
): {
  headers?: Record<string, string>;
  cache?: { blockSize?: number; maxBlocks?: number };
  signal?: AbortSignal;
  snapshotPolicy?: 'require-strong-etag' | 'best-effort';
} {
  const zipOptions = options?.zip as ZipReaderOptions | undefined;
  const http = zipOptions?.http;
  const httpOptions: {
    headers?: Record<string, string>;
    cache?: { blockSize?: number; maxBlocks?: number };
    signal?: AbortSignal;
    snapshotPolicy?: 'require-strong-etag' | 'best-effort';
  } = {};
  if (http?.headers) httpOptions.headers = http.headers;
  const cache = { ...(defaults ?? {}) };
  if (http?.cache) {
    if (http?.cache.blockSize !== undefined) cache.blockSize = http.cache.blockSize;
    if (http?.cache.maxBlocks !== undefined) cache.maxBlocks = http.cache.maxBlocks;
  }
  if (Object.keys(cache).length > 0) httpOptions.cache = cache;
  const signal = mergeSignals(options?.signal, http?.signal);
  if (signal) httpOptions.signal = signal;
  if (http?.snapshotPolicy) httpOptions.snapshotPolicy = http.snapshotPolicy;
  return httpOptions;
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

function resolveArchiveHttpSnapshotPolicy(
  options?: ArchiveOpenOptions
): 'require-strong-etag' | 'best-effort' | undefined {
  const zipOptions = options?.zip as ZipReaderOptions | undefined;
  return zipOptions?.http?.snapshotPolicy;
}

async function openZipFromRandomAccess(
  reader: RandomAccess,
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
    return openArchiveCore(new Uint8Array(0), {
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

async function preflightSeekableXzHttp(
  url: string,
  filename: string,
  options?: ArchiveOpenOptions
): Promise<XzPreflightInfo | undefined> {
  if (!shouldPreflightXz(options?.format, filename)) return undefined;
  const limits = resolveXzPreflightLimits(options?.limits, options?.profile);
  const dictionaryLimit = resolveXzDictionaryLimit(options?.limits, options?.profile);
  const snapshotPolicy = resolveArchiveHttpSnapshotPolicy(options);
  const reader = new HttpRandomAccess(url, {
    cache: { blockSize: 32 * 1024, maxBlocks: 4 },
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(snapshotPolicy ? { snapshotPolicy } : {})
  });
  try {
    const size = await reader.size(options?.signal);
    const result = await preflightXzIndexLimits(reader, size, {
      maxIndexBytes: limits.maxIndexBytes,
      maxIndexRecords: limits.maxIndexRecords,
      maxDictionaryBytes: dictionaryLimit,
      maxPreflightBlockHeaders: limits.maxPreflightBlockHeaders,
      ...(options?.signal ? { signal: options.signal } : {})
    });
    if (result && !result.ok) {
      throw buildXzPreflightError(result, limits, dictionaryLimit);
    }
    if (!result) return undefined;
    return buildXzPreflightInfo(result);
  } catch (err) {
    const mapped = mapHttpErrorToArchiveError(err, { algorithm: 'xz', feature: 'http-range', url });
    if (mapped !== err) throw mapped;
    throw mapped;
  } finally {
    await reader.close();
  }
}

async function preflightSeekableXzFile(
  path: string,
  filename: string,
  options?: ArchiveOpenOptions
): Promise<XzPreflightInfo | undefined> {
  if (!shouldPreflightXz(options?.format, filename)) return undefined;
  const limits = resolveXzPreflightLimits(options?.limits, options?.profile);
  const dictionaryLimit = resolveXzDictionaryLimit(options?.limits, options?.profile);
  const reader = await BunFileRandomAccess.fromPath(path);
  try {
    const size = await reader.size(options?.signal);
    const result = await preflightXzIndexLimits(reader, size, {
      maxIndexBytes: limits.maxIndexBytes,
      maxIndexRecords: limits.maxIndexRecords,
      maxDictionaryBytes: dictionaryLimit,
      maxPreflightBlockHeaders: limits.maxPreflightBlockHeaders,
      ...(options?.signal ? { signal: options.signal } : {})
    });
    if (result && !result.ok) {
      throw buildXzPreflightError(result, limits, dictionaryLimit);
    }
    if (!result) return undefined;
    return buildXzPreflightInfo(result);
  } finally {
    await reader.close();
  }
}

function buildXzPreflightInfo(result: {
  requiredDictionaryBytes?: number;
  requiredIndexRecords?: number;
  requiredIndexBytes?: number;
  preflightComplete?: boolean;
  preflightBlockHeaders?: number;
  preflightBlockLimit?: number;
}): XzPreflightInfo {
  const info: XzPreflightInfo = { algorithm: 'xz' };
  if (result.requiredDictionaryBytes !== undefined) {
    info.requiredDictionaryBytes = result.requiredDictionaryBytes;
  }
  if (result.requiredIndexRecords !== undefined) {
    info.requiredIndexRecords = result.requiredIndexRecords;
  }
  if (result.requiredIndexBytes !== undefined) {
    info.requiredIndexBytes = result.requiredIndexBytes;
  }
  if (result.preflightComplete !== undefined) {
    info.preflightComplete = result.preflightComplete;
  }
  if (result.preflightBlockHeaders !== undefined) {
    info.preflightBlockHeaders = result.preflightBlockHeaders;
  }
  if (result.preflightBlockLimit !== undefined) {
    info.preflightBlockLimit = result.preflightBlockLimit;
  }
  return info;
}

function buildXzPreflightError(
  result: { requiredIndexBytes?: number; requiredIndexRecords?: number; requiredDictionaryBytes?: number },
  limits: { maxIndexBytes: number; maxIndexRecords: number },
  dictionaryLimit: bigint
): CompressionError {
  if (result.requiredDictionaryBytes !== undefined && BigInt(result.requiredDictionaryBytes) > dictionaryLimit) {
    const context = {
      algorithm: 'xz',
      requiredDictionaryBytes: String(result.requiredDictionaryBytes),
      limitDictionaryBytes: dictionaryLimit.toString()
    };
    return new CompressionError(
      'COMPRESSION_RESOURCE_LIMIT',
      `XZ dictionary size ${result.requiredDictionaryBytes} exceeds limit`,
      { algorithm: 'xz', context }
    );
  }
  if (result.requiredIndexRecords !== undefined && result.requiredIndexRecords > limits.maxIndexRecords) {
    const context = {
      algorithm: 'xz',
      requiredIndexRecords: String(result.requiredIndexRecords),
      limitIndexRecords: String(limits.maxIndexRecords)
    };
    return new CompressionError(
      'COMPRESSION_RESOURCE_LIMIT',
      `XZ index record count ${result.requiredIndexRecords} exceeds limit`,
      { algorithm: 'xz', context }
    );
  }
  if (result.requiredIndexBytes !== undefined && result.requiredIndexBytes > limits.maxIndexBytes) {
    const context = {
      algorithm: 'xz',
      requiredIndexBytes: String(result.requiredIndexBytes),
      limitIndexBytes: String(limits.maxIndexBytes)
    };
    return new CompressionError('COMPRESSION_RESOURCE_LIMIT', `XZ index size ${result.requiredIndexBytes} exceeds limit`, {
      algorithm: 'xz',
      context
    });
  }
  return new CompressionError('COMPRESSION_RESOURCE_LIMIT', 'XZ index exceeds resource limits', {
    algorithm: 'xz',
    context: { algorithm: 'xz' }
  });
}

class BunFileRandomAccess implements RandomAccess {
  private constructor(private readonly file: BunFile, private readonly sizeValue: bigint) {}

  static async fromPath(path: string): Promise<BunFileRandomAccess> {
    const file = requireBun().file(path);
    const size = typeof file.size === 'number' ? file.size : Number((await file.arrayBuffer()).byteLength);
    return new BunFileRandomAccess(file, BigInt(size));
  }

  async size(signal?: AbortSignal): Promise<bigint> {
    throwIfAborted(signal);
    return this.sizeValue;
  }

  async read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);
    if (length <= 0) return new Uint8Array(0);
    const start = Number(offset);
    const maxLength = Number(this.sizeValue - offset);
    const toRead = Math.max(0, Math.min(length, maxLength));
    if (toRead === 0) return new Uint8Array(0);
    const slice = this.file.slice ? this.file.slice(start, start + toRead) : this.file;
    const buf = await slice.arrayBuffer();
    return new Uint8Array(buf).subarray(0, toRead);
  }

  async close(): Promise<void> {
    return;
  }
}

export async function tarToFile(
  path: string,
  options?: Parameters<typeof TarWriter.toWritable>[1]
): Promise<TarWriter> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = TarWriter.toWritable(writable, options);
  const close = writer.close.bind(writer);
  writer.close = async (...args: Parameters<typeof close>) => {
    await close(...args);
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    await requireBun().write(path, out);
  };
  return writer;
}
