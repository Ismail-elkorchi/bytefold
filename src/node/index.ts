import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { ArchiveDetectionReport, ArchiveInputKind, ArchiveOpenOptions } from '../archive/types.js';
import { openArchive as openArchiveCore, type ArchiveReader } from '../archive/index.js';
import { createDecompressor } from '../compress/index.js';
import { CompressionError } from '../compress/errors.js';
import { readAllBytes } from '../streams/buffer.js';
import { toWebReadable } from '../streams/adapters.js';
import { readableFromBytes } from '../streams/web.js';
import { preflightXzIndexLimits } from '../compression/xzIndexPreflight.js';
import { HttpRandomAccess, type RandomAccess } from '../reader/RandomAccess.js';
import { mapHttpErrorToZipError, wrapRandomAccessForZip } from '../reader/httpZipErrors.js';
import { ZipReader } from '../reader/ZipReader.js';
import { FileRandomAccess } from './zip/RandomAccess.js';
import { mergeSignals } from '../abort.js';
import { ArchiveError } from '../archive/errors.js';
import { mapHttpErrorToArchiveError } from '../archive/httpArchiveErrors.js';
import { ZipError } from '../errors.js';
import { resolveXzDictionaryLimit, resolveXzPreflightLimits, shouldPreflightXz } from '../archive/xzPreflight.js';
import { isZipSignature, preflightZip, resolveZipPreflightLimits, shouldPreflightZip } from '../archive/zipPreflight.js';
import type { ZipProfile, ZipReaderOptions } from '../types.js';

/** Typed archive error class for Node runtime adapters. */
export { ArchiveError } from '../archive/errors.js';
/** Archive report/input/options/domain types for Node runtime adapters. */
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
/** Unified archive reader/writer types. */
export type { ArchiveReader, ArchiveWriter } from '../archive/index.js';
/** Create archive writers from Node runtime entrypoint. */
export { createArchiveWriter } from '../archive/index.js';

/** ZIP APIs and ZIP-domain types from Node runtime entrypoint. */
export * from './zip/index.js';
/** TAR APIs and TAR-domain types from Node runtime entrypoint. */
export * from '../tar/index.js';

/** Node/Web stream adapter helpers. */
export { toWebReadable, toWebWritable, toNodeReadable, toNodeWritable } from '../streams/adapters.js';

/** Inputs accepted by the Node runtime adapter. */
export type NodeArchiveInput =
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>
  | NodeJS.ReadableStream
  | string
  | URL;

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

/** Open an archive input through Node runtime facilities. */
export async function openArchive(input: NodeArchiveInput, options?: ArchiveOpenOptions): Promise<ArchiveReader> {
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
    const remoteUrl = resolveHttpUrl(input);
    const formatOption = options?.format ?? 'auto';
    if (remoteUrl) {
      const url = remoteUrl.toString();
      const filename = options?.filename ?? inferFilenameFromUrl(url);
      if (shouldPreflightZip(formatOption, filename)) {
        const detection = buildZipDetection(
          'url',
          formatOption === 'zip' ? 'forced' : 'filename'
        );
        const reader = wrapRandomAccessForZip(
          new HttpRandomAccess(url, resolveZipHttpOptions(options, { blockSize: 32 * 1024, maxBlocks: 4 }))
        );
        return openZipFromRandomAccess(reader, detection, options, filename);
      }
      if (formatOption === 'auto') {
        const reader = wrapRandomAccessForZip(
          new HttpRandomAccess(url, resolveZipHttpOptions(options, { blockSize: 32 * 1024, maxBlocks: 4 }))
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
      const preflight = await preflightSeekableXz(url, filename, options);
      const data = await resolveNodeInputBytes(url, options);
      return openArchiveCore(data, {
        ...options,
        ...(preflight ? { __preflight: preflight } : {}),
        ...(options?.inputKind ? {} : { inputKind: 'url' }),
        ...(options?.filename ? {} : { filename })
      } as ArchiveOpenOptionsInternal);
    }
    const filePath = typeof input === 'string' ? input : fileURLToPath(input);
    const filename = options?.filename ?? filePath;
    if (shouldPreflightZip(formatOption, filename)) {
      const detection = buildZipDetection(
        input instanceof URL ? 'url' : 'file',
        formatOption === 'zip' ? 'forced' : 'filename'
      );
      const reader = FileRandomAccess.fromPath(filePath);
      return openZipFromRandomAccess(reader, detection, options, filePath);
    }
    if (formatOption === 'auto') {
      const reader = FileRandomAccess.fromPath(filePath);
      try {
        const signature = await reader.read(0n, 4, options?.signal);
        if (isZipSignature(signature)) {
          const detection = buildZipDetection(input instanceof URL ? 'url' : 'file', 'magic');
          return openZipFromRandomAccess(reader, detection, options, filePath);
        }
      } catch (err) {
        await reader.close().catch(() => {});
        throw err;
      }
      await reader.close();
    }
    const preflight = await preflightSeekableXzFile(filePath, filename, options);
    const data = await readFileBytes(filePath, options);
    return openArchiveCore(data, {
      ...options,
      ...(preflight ? { __preflight: preflight } : {}),
      ...(options?.inputKind ? {} : { inputKind: input instanceof URL ? 'url' : 'file' }),
      ...(options?.filename ? {} : { filename: filePath })
    } as ArchiveOpenOptionsInternal);
  }
  if (isReadableStream(input)) {
    return openArchiveCore(input, {
      ...options,
      ...(options?.inputKind ? {} : { inputKind: 'stream' })
    });
  }
  const webStream = toWebReadable(input as NodeJS.ReadableStream);
  return openArchiveCore(webStream, {
    ...options,
    ...(options?.inputKind ? {} : { inputKind: 'stream' })
  });
}

/** Extract all entries from a source archive into a destination directory. */
export async function extractAll(
  input: NodeArchiveInput,
  destDir: string | URL,
  options?: ArchiveOpenOptions
): Promise<void> {
  const bytes = await resolveNodeInputBytes(input, options);
  const filenameHint =
    options?.filename ??
    (typeof input === 'string' || input instanceof URL ? (input instanceof URL ? fileURLToPath(input) : input) : undefined);
  const entryName = inferXzEntryName(filenameHint);
  const baseDir = typeof destDir === 'string' ? destDir : fileURLToPath(destDir);
  await mkdir(baseDir, { recursive: true });
  const tempDir = await mkdtemp(path.join(baseDir, '.bytefold-xz-'));
  const tempPath = path.join(tempDir, 'extract.tmp');
  const targetPath = path.join(baseDir, entryName);
  const decompressor = createDecompressor({
    algorithm: 'xz',
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.limits?.maxTotalDecompressedBytes !== undefined
      ? { maxOutputBytes: options.limits.maxTotalDecompressedBytes }
      : options?.limits?.maxTotalUncompressedBytes !== undefined
        ? { maxOutputBytes: options.limits.maxTotalUncompressedBytes }
        : {}),
    ...(options?.limits?.maxCompressionRatio !== undefined ? { maxCompressionRatio: options.limits.maxCompressionRatio } : {}),
    ...(options?.limits?.maxXzDictionaryBytes !== undefined
      ? { maxDictionaryBytes: options.limits.maxXzDictionaryBytes }
      : options?.limits?.maxDictionaryBytes !== undefined
        ? { maxDictionaryBytes: options.limits.maxDictionaryBytes }
        : {}),
    ...(options?.limits?.maxXzBufferedBytes !== undefined
      ? { maxBufferedInputBytes: options.limits.maxXzBufferedBytes }
      : {}),
    ...(options?.limits ? { limits: options.limits } : {}),
    ...(options?.profile ? { profile: options.profile } : {})
  });
  const stream = readableFromBytes(bytes).pipeThrough(decompressor);
  const nodeReadable = Readable.fromWeb(stream as unknown as NodeReadableStream);
  try {
    await pipeline(nodeReadable, createWriteStream(tempPath));
    await installExtractedFile(tempPath, targetPath, entryName);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof (value as ReadableStream<Uint8Array>).getReader === 'function';
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

function resolveHttpUrl(value: string | URL): URL | null {
  const url = typeof value === 'string' ? safeParseUrl(value) : value;
  if (!url) return null;
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
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

async function preflightSeekableXz(
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
  pathname: string,
  filename: string,
  options?: ArchiveOpenOptions
): Promise<XzPreflightInfo | undefined> {
  if (!shouldPreflightXz(options?.format, filename)) return undefined;
  const limits = resolveXzPreflightLimits(options?.limits, options?.profile);
  const dictionaryLimit = resolveXzDictionaryLimit(options?.limits, options?.profile);
  const reader = FileRandomAccess.fromPath(pathname);
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

async function resolveNodeInputBytes(input: NodeArchiveInput, options?: ArchiveOpenOptions): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof input === 'string' || input instanceof URL) {
    const remoteUrl = resolveHttpUrl(input);
    if (remoteUrl) {
      return readHttpUrlBytes(remoteUrl, options);
    }
    const filePath = typeof input === 'string' ? input : fileURLToPath(input);
    return readFileBytes(filePath, options);
  }
  const readOptions = resolveInputReadOptions(options);
  if (isReadableStream(input)) {
    return readAllBytes(input, readOptions);
  }
  const webStream = toWebReadable(input as NodeJS.ReadableStream);
  return readAllBytes(webStream, readOptions);
}

async function readHttpUrlBytes(url: URL, options?: ArchiveOpenOptions): Promise<Uint8Array> {
  const response = await fetch(url, options?.signal ? { signal: options.signal } : undefined);
  if (!response.ok) {
    throw new ArchiveError('ARCHIVE_BAD_HEADER', `Unexpected HTTP status ${response.status}`);
  }
  return readResponseBytes(response, options);
}

function resolveInputReadOptions(options?: ArchiveOpenOptions): { signal?: AbortSignal; maxBytes?: bigint | number } {
  const readOptions: { signal?: AbortSignal; maxBytes?: bigint | number } = {};
  if (options?.signal) readOptions.signal = options.signal;
  const maxBytes = resolveInputMaxBytes(options);
  if (maxBytes !== undefined) readOptions.maxBytes = maxBytes;
  return readOptions;
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

async function readResponseBytes(response: Response, options?: ArchiveOpenOptions): Promise<Uint8Array> {
  const maxBytes = resolveInputMaxBytes(options);
  if (maxBytes !== undefined) {
    const contentLength = response.headers.get('content-length');
    if (contentLength && /^\d+$/u.test(contentLength)) {
      if (BigInt(contentLength) > toBigInt(maxBytes)) {
        throw new RangeError('Stream exceeds maximum allowed size');
      }
    }
  }
  const body = response.body;
  if (!body) return new Uint8Array(0);
  return readAllBytes(body, resolveInputReadOptions(options));
}

async function readFileBytes(filePath: string, options?: ArchiveOpenOptions): Promise<Uint8Array> {
  return readAllBytes(toWebReadable(createReadStream(filePath)), resolveInputReadOptions(options));
}

async function installExtractedFile(tempPath: string, targetPath: string, entryName: string): Promise<void> {
  try {
    await link(tempPath, targetPath);
  } catch (err) {
    if (isExistingPathError(err)) {
      throw new ArchiveError(
        'ARCHIVE_NAME_COLLISION',
        'Destination already contains the extracted file. Rename or remove the existing file first.',
        {
          entryName,
          context: buildExistingCollisionContext(entryName, targetPath, 'xz')
        }
      );
    }
    throw err;
  }
}

function toBigInt(value: bigint | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function inferXzEntryName(filename?: string): string {
  const base = sanitizeSingleFileName(filename);
  if (!base) return 'data';
  const lower = base.toLowerCase();
  if (lower.endsWith('.tar.xz')) {
    const stem = sanitizeSingleFileName(base.slice(0, -7));
    return stem ? `${stem}.tar` : 'data';
  }
  if (lower.endsWith('.txz')) {
    const stem = sanitizeSingleFileName(base.slice(0, -4));
    return stem ? `${stem}.tar` : 'data';
  }
  if (lower.endsWith('.xz')) {
    const stem = sanitizeSingleFileName(base.slice(0, -3));
    return stem || 'data';
  }
  return 'data';
}

function sanitizeSingleFileName(name?: string): string | undefined {
  if (!name) return undefined;
  if (name.includes('\u0000')) return undefined;
  const base = name.split(/[\\/]/).pop() ?? name;
  const trimmed = base.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return undefined;
  return trimmed;
}

function isExistingPathError(err: unknown): err is NodeJS.ErrnoException {
  if (!err || typeof err !== 'object') return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EEXIST' || code === 'EISDIR';
}

function buildExistingCollisionContext(
  entryName: string,
  targetPath: string,
  format: 'xz'
): Record<string, string> {
  return {
    collisionType: 'existing',
    collisionKind: 'existing',
    nameA: targetPath,
    nameB: entryName,
    key: entryName,
    format
  };
}
