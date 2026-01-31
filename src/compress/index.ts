import { createCompressTransform, createDecompressTransform } from '../compression/streams.js';
import type { CompressionProgress } from '../compression/streams.js';
import { ZipError } from '../errors.js';
import { CompressionError } from './errors.js';
import type { CompressionAlgorithm, CompressionCapabilities, CompressionOptions } from './types.js';

export type { CompressionAlgorithm, CompressionCapabilities, CompressionOptions } from './types.js';
export type { CompressionBackend, CompressionProgressEvent } from './types.js';
export { CompressionError } from './errors.js';

export function getCompressionCapabilities(): CompressionCapabilities {
  const runtime = detectRuntime();
  const notes: string[] = [];
  const algorithms = {
    gzip: { compress: false, decompress: false, backend: 'none' },
    deflate: { compress: false, decompress: false, backend: 'none' },
    'deflate-raw': { compress: false, decompress: false, backend: 'none' },
    brotli: { compress: false, decompress: false, backend: 'none' },
    zstd: { compress: false, decompress: false, backend: 'none' }
  } as CompressionCapabilities['algorithms'];

  for (const algorithm of Object.keys(algorithms) as CompressionAlgorithm[]) {
    const webCompress = supportsWebCompression(algorithm, 'compress');
    const webDecompress = supportsWebCompression(algorithm, 'decompress');

    if (runtime === 'node') {
      const nodeCompress = supportsNodeZlib(algorithm, 'compress', notes);
      const nodeDecompress = supportsNodeZlib(algorithm, 'decompress', notes);
      if (nodeCompress || nodeDecompress) {
        algorithms[algorithm] = {
          compress: nodeCompress,
          decompress: nodeDecompress,
          backend: 'node-zlib'
        };
        continue;
      }
    }

    if (webCompress || webDecompress) {
      algorithms[algorithm] = {
        compress: webCompress,
        decompress: webDecompress,
        backend: 'web'
      };
    }
  }

  if (runtime !== 'node' && typeof CompressionStream === 'undefined') {
    notes.push('CompressionStream not available in this runtime');
  }

  return { runtime, algorithms, notes };
}

export function createCompressor(options: CompressionOptions): TransformStream<Uint8Array, Uint8Array> {
  ensureSupported(options.algorithm, 'compress');
  const transformPromise = createCompressTransform({
    algorithm: options.algorithm,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.level !== undefined ? { level: options.level } : {}),
    ...(options.quality !== undefined ? { quality: options.quality } : {}),
    ...(options.onProgress
      ? {
          onProgress: (event: CompressionProgress) =>
            options.onProgress?.({
              kind: 'compress',
              algorithm: options.algorithm,
              bytesIn: event.bytesIn,
              bytesOut: event.bytesOut
            })
        }
      : {})
  }).catch((err) => {
    throw mapCompressionError(options.algorithm, err);
  });
  return createLazyTransform(transformPromise);
}

export function createDecompressor(options: CompressionOptions): TransformStream<Uint8Array, Uint8Array> {
  ensureSupported(options.algorithm, 'decompress');
  const transformPromise = createDecompressTransform({
    algorithm: options.algorithm,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress
      ? {
          onProgress: (event: CompressionProgress) =>
            options.onProgress?.({
              kind: 'decompress',
              algorithm: options.algorithm,
              bytesIn: event.bytesIn,
              bytesOut: event.bytesOut
            })
        }
      : {})
  }).catch((err) => {
    throw mapCompressionError(options.algorithm, err);
  });
  return createLazyTransform(transformPromise);
}

function mapCompressionError(algorithm: CompressionAlgorithm, err: unknown): CompressionError {
  if (err instanceof CompressionError) return err;
  if (err instanceof ZipError) {
    if (err.code === 'ZIP_UNSUPPORTED_METHOD' || err.code === 'ZIP_ZSTD_UNAVAILABLE') {
      return new CompressionError(
        'COMPRESSION_UNSUPPORTED_ALGORITHM',
        `Compression algorithm ${algorithm} is not supported in this runtime`,
        { algorithm, cause: err }
      );
    }
  }
  return new CompressionError('COMPRESSION_BACKEND_UNAVAILABLE', 'Compression backend failed', {
    algorithm,
    cause: err
  });
}

type CompressionMode = 'compress' | 'decompress';

function ensureSupported(algorithm: CompressionAlgorithm, mode: CompressionMode): void {
  const caps = getCompressionCapabilities();
  const supported = mode === 'compress' ? caps.algorithms[algorithm].compress : caps.algorithms[algorithm].decompress;
  if (!supported) {
    throw new CompressionError(
      'COMPRESSION_UNSUPPORTED_ALGORITHM',
      `Compression algorithm ${algorithm} is not supported in this runtime`,
      { algorithm }
    );
  }
}

function createLazyTransform(
  pairPromise: Promise<ReadableWritablePair<Uint8Array, Uint8Array>>
): TransformStream<Uint8Array, Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  const ensure = async () => {
    const pair = await pairPromise;
    if (!reader) reader = pair.readable.getReader();
    if (!writer) writer = pair.writable.getWriter();
    return { reader, writer };
  };

  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { reader } = await ensure();
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value) controller.enqueue(value);
    },
    async cancel(reason) {
      const { reader } = await ensure();
      await reader.cancel(reason);
    }
  });

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      const { writer } = await ensure();
      await writer.write(chunk);
    },
    async close() {
      const { writer } = await ensure();
      await writer.close();
    },
    async abort(reason) {
      const { writer } = await ensure();
      await writer.abort(reason);
    }
  });

  return { readable, writable } as TransformStream<Uint8Array, Uint8Array>;
}

function detectRuntime(): CompressionCapabilities['runtime'] {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') return 'bun';
  if (typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined') return 'deno';
  if (typeof process !== 'undefined' && !!process.versions?.node) return 'node';
  return 'unknown';
}

function supportsWebCompression(algorithm: CompressionAlgorithm, mode: CompressionMode): boolean {
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') return false;
  try {
    if (mode === 'compress') {
      // eslint-disable-next-line no-new
      new CompressionStream(algorithm as unknown as CompressionFormat);
    } else {
      // eslint-disable-next-line no-new
      new DecompressionStream(algorithm as unknown as CompressionFormat);
    }
    return true;
  } catch {
    return false;
  }
}

function supportsNodeZlib(
  algorithm: CompressionAlgorithm,
  _mode: CompressionMode,
  notes: string[]
): boolean {
  if (typeof process === 'undefined' || !process.versions?.node) return false;
  if (algorithm === 'gzip' || algorithm === 'deflate' || algorithm === 'deflate-raw') return true;
  if (algorithm === 'brotli') {
    notes.push('Brotli support inferred from Node runtime (no direct sync probe).');
    return true;
  }
  if (algorithm === 'zstd') {
    const zstdFlag = (process as unknown as { config?: { variables?: Record<string, unknown> } }).config?.variables
      ?.node_use_zstd;
    const zstdVersion = (process.versions as Record<string, string | undefined>).zstd;
    const enabled =
      typeof zstdFlag === 'boolean'
        ? zstdFlag
        : typeof zstdFlag === 'number'
          ? zstdFlag !== 0
          : typeof zstdFlag === 'string'
            ? zstdFlag !== '0' && zstdFlag.toLowerCase() !== 'false'
            : !!zstdVersion;
    if (!enabled) {
      notes.push('Zstandard support not detected from Node build flags.');
    }
    return enabled;
  }
  return false;
}
