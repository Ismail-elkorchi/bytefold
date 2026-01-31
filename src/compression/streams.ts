import { ZipError } from '../errors.js';

export type CompressionAlgorithm = 'gzip' | 'deflate' | 'deflate-raw' | 'brotli' | 'zstd';
export type CompressionMode = 'compress' | 'decompress';

export type CompressionProgress = {
  bytesIn: bigint;
  bytesOut: bigint;
};

export interface CompressionTransformOptions {
  algorithm: CompressionAlgorithm;
  signal?: AbortSignal;
  onProgress?: (event: CompressionProgress) => void;
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
  if (await nodeSupports(algorithm, mode)) return true;
  return supportsWebCompression(algorithm, mode);
}

async function createTransform(
  mode: CompressionMode,
  options: CompressionTransformOptions
): Promise<ReadableWritablePair<Uint8Array, Uint8Array>> {
  const { algorithm } = options;
  const nodeBackend = await getNodeBackend();
  if (nodeBackend?.supports(algorithm, mode)) {
    const transform = nodeBackend.create(algorithm, mode, options.signal);
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
            signal?: AbortSignal
          ) => ReadableWritablePair<Uint8Array, Uint8Array>;
        }
      | null
    >
  | null = null;

async function getNodeBackend() {
  if (!isNodeRuntime()) return null;
  if (!nodeBackendPromise) {
    nodeBackendPromise = import('./node-backend.js')
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
const WEB_FORMATS = new Set<CompressionAlgorithm>(['gzip', 'deflate', 'deflate-raw']);
type WebCompressionFormat = 'gzip' | 'deflate' | 'deflate-raw';

function toWebCompressionFormat(algorithm: CompressionAlgorithm): WebCompressionFormat | null {
  if (!WEB_FORMATS.has(algorithm)) return null;
  return algorithm as WebCompressionFormat;
}

function supportsWebCompression(algorithm: CompressionAlgorithm, mode: CompressionMode): boolean {
  const key = `${mode}:${algorithm}`;
  const cached = webSupportCache.get(key);
  if (cached !== undefined) return cached;
  const webAlgorithm = toWebCompressionFormat(algorithm);
  if (!webAlgorithm) {
    webSupportCache.set(key, false);
    return false;
  }
  let ok = false;
  try {
    if (mode === 'compress') {
      // eslint-disable-next-line no-new
      new CompressionStream(webAlgorithm);
    } else {
      // eslint-disable-next-line no-new
      new DecompressionStream(webAlgorithm);
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
  const webAlgorithm = toWebCompressionFormat(algorithm);
  if (!webAlgorithm) {
    throw new ZipError('ZIP_UNSUPPORTED_METHOD', `Compression algorithm ${algorithm} is not supported by Web streams`);
  }
  const transform = (mode === 'compress'
    ? new CompressionStream(webAlgorithm)
    : new DecompressionStream(webAlgorithm)) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
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
