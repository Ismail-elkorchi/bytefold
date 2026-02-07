import { ZipError } from '../errors.js';
import { createBzip2DecompressStream } from './bzip2.js';
import { createXzDecompressStream } from './xz.js';
import type { CompressionProfile } from '../compress/types.js';

export type CompressionAlgorithm = 'gzip' | 'deflate' | 'deflate-raw' | 'brotli' | 'zstd' | 'bzip2' | 'xz';
export type CompressionMode = 'compress' | 'decompress';

export type CompressionProgress = {
  bytesIn: bigint;
  bytesOut: bigint;
};

export interface CompressionTransformOptions {
  algorithm: CompressionAlgorithm;
  signal?: AbortSignal;
  onProgress?: (event: CompressionProgress) => void;
  level?: number;
  quality?: number;
  maxOutputBytes?: bigint | number;
  maxCompressionRatio?: number;
  maxDictionaryBytes?: bigint | number;
  maxBufferedInputBytes?: number;
  maxBzip2BlockSize?: number;
  /** @internal */
  __xzDebug?: {
    maxBufferedInputBytes?: number;
    maxDictionaryBytesUsed?: number;
    totalBytesIn?: number;
    totalBytesOut?: number;
  };
  profile?: CompressionProfile;
}

export async function createCompressTransform(
  options: CompressionTransformOptions
): Promise<ReadableWritablePair<Uint8Array, Uint8Array>> {
  return createTransform('compress', options);
}

export async function createDecompressTransform(
  options: CompressionTransformOptions
): Promise<ReadableWritablePair<Uint8Array, Uint8Array>> {
  return createTransform('decompress', options);
}

export async function supportsCompressionAlgorithm(
  algorithm: CompressionAlgorithm,
  mode: CompressionMode
): Promise<boolean> {
  if (algorithm === 'bzip2') return mode === 'decompress';
  if (algorithm === 'xz') return mode === 'decompress';
  if (await nodeSupports(algorithm, mode)) return true;
  return supportsWebCompression(algorithm, mode);
}

async function createTransform(
  mode: CompressionMode,
  options: CompressionTransformOptions
): Promise<ReadableWritablePair<Uint8Array, Uint8Array>> {
  const { algorithm } = options;
  if (algorithm === 'bzip2') {
    if (mode !== 'decompress') {
      throw new ZipError('ZIP_UNSUPPORTED_METHOD', 'BZip2 compression is not supported');
    }
    const transform = createBzip2DecompressStream({
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.maxCompressionRatio !== undefined ? { maxCompressionRatio: options.maxCompressionRatio } : {}),
      ...(options.maxBzip2BlockSize !== undefined ? { maxBlockSize: options.maxBzip2BlockSize } : {})
    });
    return attachProgress(transform, options.onProgress);
  }
  if (algorithm === 'xz') {
    if (mode !== 'decompress') {
      throw new ZipError('ZIP_UNSUPPORTED_METHOD', 'XZ compression is not supported');
    }
    const transform = createXzDecompressStream({
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.maxCompressionRatio !== undefined ? { maxCompressionRatio: options.maxCompressionRatio } : {}),
      ...(options.maxDictionaryBytes !== undefined ? { maxDictionaryBytes: options.maxDictionaryBytes } : {}),
      ...(options.maxBufferedInputBytes !== undefined ? { maxBufferedInputBytes: options.maxBufferedInputBytes } : {}),
      ...(options.__xzDebug ? { __xzDebug: options.__xzDebug } : {}),
      ...(options.profile ? { profile: options.profile } : {})
    });
    return attachProgress(transform, options.onProgress);
  }
  const nodeBackend = await getNodeBackend();
  if (nodeBackend?.supports(algorithm, mode)) {
    const transform = nodeBackend.create(algorithm, mode, options);
    return attachProgress(transform, options.onProgress);
  }

  if (supportsWebCompression(algorithm, mode)) {
    const transform = createWebCompressionTransform(algorithm, mode, options.signal);
    return attachProgress(transform, options.onProgress);
  }

  throw new ZipError('ZIP_UNSUPPORTED_METHOD', `Compression algorithm ${algorithm} not supported`);
}

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

let nodeBackendPromise:
  | Promise<
      | {
          supports: (algorithm: CompressionAlgorithm, mode: CompressionMode) => boolean;
          create: (
            algorithm: CompressionAlgorithm,
            mode: CompressionMode,
            options?: CompressionTransformOptions
          ) => ReadableWritablePair<Uint8Array, Uint8Array>;
        }
      | null
    >
  | null = null;

async function getNodeBackend() {
  if (!isNodeRuntime()) return null;
  if (!nodeBackendPromise) {
    const moduleUrl = new URL('./node-backend.js', import.meta.url).href;
    nodeBackendPromise = import(moduleUrl)
      .then((mod) => mod.nodeBackend)
      .catch(() => null);
  }
  return nodeBackendPromise;
}

async function nodeSupports(algorithm: CompressionAlgorithm, mode: CompressionMode): Promise<boolean> {
  const backend = await getNodeBackend();
  return backend ? backend.supports(algorithm, mode) : false;
}

const webSupportCache = new Map<string, boolean>();

function supportsWebCompression(algorithm: CompressionAlgorithm, mode: CompressionMode): boolean {
  const key = `${mode}:${algorithm}`;
  const cached = webSupportCache.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    if (mode === 'compress') {
      const stream = new CompressionStream(algorithm as unknown as CompressionFormat);
      void stream;
    } else {
      const stream = new DecompressionStream(algorithm as unknown as CompressionFormat);
      void stream;
    }
    ok = true;
  } catch {
    ok = false;
  }
  webSupportCache.set(key, ok);
  return ok;
}

function createWebCompressionTransform(
  algorithm: CompressionAlgorithm,
  mode: CompressionMode,
  signal?: AbortSignal
): ReadableWritablePair<Uint8Array, Uint8Array> {
  let transform: ReadableWritablePair<Uint8Array, Uint8Array>;
  try {
    transform = (mode === 'compress'
      ? new CompressionStream(algorithm as unknown as CompressionFormat)
      : new DecompressionStream(algorithm as unknown as CompressionFormat)) as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >;
  } catch {
    throw new ZipError('ZIP_UNSUPPORTED_METHOD', `Compression algorithm ${algorithm} is not supported by Web streams`);
  }
  if (signal) {
    if (signal.aborted) {
      transform.writable.abort(signal.reason).catch(() => {});
    } else {
      signal.addEventListener(
        'abort',
        () => {
          transform.writable.abort(signal.reason).catch(() => {});
          transform.readable.cancel(signal.reason).catch(() => {});
        },
        { once: true }
      );
    }
  }
  return transform;
}

function attachProgress(
  transform: ReadableWritablePair<Uint8Array, Uint8Array>,
  onProgress?: (event: CompressionProgress) => void
): ReadableWritablePair<Uint8Array, Uint8Array> {
  if (!onProgress) return transform;
  let bytesIn = 0n;
  let bytesOut = 0n;
  const inTap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesIn += BigInt(chunk.length);
      onProgress({ bytesIn, bytesOut });
      controller.enqueue(chunk);
    }
  });
  const outTap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesOut += BigInt(chunk.length);
      onProgress({ bytesIn, bytesOut });
      controller.enqueue(chunk);
    }
  });
  const readable = inTap.readable.pipeThrough(transform).pipeThrough(outTap);
  return { readable, writable: inTap.writable };
}
