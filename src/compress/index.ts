import { createCompressTransform, createDecompressTransform, type CompressionProgress } from '../compression/streams.js';
import { ZipError } from '../errors.js';
import { CompressionError } from './errors.js';
import type { CompressionAlgorithm, CompressionCapabilities, CompressionOptions } from './types.js';
import { BYTEFOLD_REPORT_SCHEMA_VERSION } from '../reportSchema.js';
import type { ResourceLimits } from '../limits.js';

export type { CompressionAlgorithm, CompressionCapabilities, CompressionOptions, CompressionProfile } from './types.js';
export type { CompressionBackend, CompressionProgressEvent } from './types.js';
export { CompressionError } from './errors.js';
export type { CompressionErrorCode } from './errors.js';

const PROBE_PAYLOAD = new TextEncoder().encode('bytefold-probe');
const RUNTIME = detectRuntime();
const WEB_PROBES: WebProbeResults | null =
  RUNTIME === 'bun' || RUNTIME === 'deno' ? await probeWebCompression() : null;

/** Inspect compression support in the current runtime. */
export function getCompressionCapabilities(): CompressionCapabilities {
  const runtime = RUNTIME;
  const notes: string[] = [];
  const noteSet = new Set<string>();
  const addNote = (note: string) => {
    if (!noteSet.has(note)) {
      noteSet.add(note);
      notes.push(note);
    }
  };
  const algorithms = {
    gzip: { compress: false, decompress: false, backend: 'none' },
    deflate: { compress: false, decompress: false, backend: 'none' },
    'deflate-raw': { compress: false, decompress: false, backend: 'none' },
    brotli: { compress: false, decompress: false, backend: 'none' },
    zstd: { compress: false, decompress: false, backend: 'none' },
    bzip2: { compress: false, decompress: true, backend: 'pure-js' },
    xz: { compress: false, decompress: true, backend: 'pure-js' }
  } as CompressionCapabilities['algorithms'];

  for (const algorithm of Object.keys(algorithms) as CompressionAlgorithm[]) {
    if (algorithm === 'bzip2') continue;
    if (algorithm === 'xz') continue;
    if (runtime === 'node') {
      const nodeSupport = probeNodeCompression(algorithm);
      const nodeCompress = nodeSupport?.compress ?? false;
      const nodeDecompress = nodeSupport?.decompress ?? false;
      if (nodeCompress || nodeDecompress) {
        algorithms[algorithm] = {
          compress: nodeCompress,
          decompress: nodeDecompress,
          backend: 'node-zlib'
        };
        continue;
      }
    }
    const webSupport = WEB_PROBES && WEB_PROBES[algorithm] ? WEB_PROBES[algorithm] : { compress: false, decompress: false, backend: 'none' as const };
    if (webSupport.compress || webSupport.decompress) {
      algorithms[algorithm] = {
        compress: webSupport.compress,
        decompress: webSupport.decompress,
        backend: webSupport.backend
      };
    }
  }

  if (runtime === 'deno') {
    if (
      algorithms.brotli.compress ||
      algorithms.brotli.decompress ||
      algorithms.zstd.compress ||
      algorithms.zstd.decompress
    ) {
      addNote('Brotli and zstd are disabled on Deno for deterministic support.');
    }
    algorithms.brotli = { compress: false, decompress: false, backend: 'none' };
    algorithms.zstd = { compress: false, decompress: false, backend: 'none' };
  }

  if (runtime !== 'node' && WEB_PROBES?.note) {
    addNote(WEB_PROBES.note);
  }

  return { schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION, runtime, algorithms, notes };
}

/** Create a TransformStream that compresses chunks with the selected algorithm. */
export function createCompressor(options: CompressionOptions): TransformStream<Uint8Array, Uint8Array> {
  ensureSupported(options.algorithm, 'compress');
  const resolved = resolveCompressionLimits(options);
  const transformPromise = createCompressTransform({
    algorithm: options.algorithm,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.level !== undefined ? { level: options.level } : {}),
    ...(options.quality !== undefined ? { quality: options.quality } : {}),
    ...(resolved.maxOutputBytes !== undefined ? { maxOutputBytes: resolved.maxOutputBytes } : {}),
    ...(resolved.maxCompressionRatio !== undefined ? { maxCompressionRatio: resolved.maxCompressionRatio } : {}),
    ...(resolved.maxDictionaryBytes !== undefined ? { maxDictionaryBytes: resolved.maxDictionaryBytes } : {}),
    ...(resolved.maxBufferedInputBytes !== undefined ? { maxBufferedInputBytes: resolved.maxBufferedInputBytes } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
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

/** Create a TransformStream that decompresses chunks with the selected algorithm. */
export function createDecompressor(options: CompressionOptions): TransformStream<Uint8Array, Uint8Array> {
  ensureSupported(options.algorithm, 'decompress');
  const resolved = resolveCompressionLimits(options);
  const debug = (options as {
    __xzDebug?: {
      maxBufferedInputBytes?: number;
      maxDictionaryBytesUsed?: number;
      totalBytesIn?: number;
      totalBytesOut?: number;
    };
  }).__xzDebug;
  const transformPromise = createDecompressTransform({
    algorithm: options.algorithm,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(resolved.maxOutputBytes !== undefined ? { maxOutputBytes: resolved.maxOutputBytes } : {}),
    ...(resolved.maxCompressionRatio !== undefined ? { maxCompressionRatio: resolved.maxCompressionRatio } : {}),
    ...(resolved.maxDictionaryBytes !== undefined ? { maxDictionaryBytes: resolved.maxDictionaryBytes } : {}),
    ...(resolved.maxBufferedInputBytes !== undefined ? { maxBufferedInputBytes: resolved.maxBufferedInputBytes } : {}),
    ...(resolved.maxBzip2BlockSize !== undefined ? { maxBzip2BlockSize: resolved.maxBzip2BlockSize } : {}),
    ...(debug ? { __xzDebug: debug } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
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
  const base = createLazyTransform(transformPromise);
  if (resolved.maxOutputBytes !== undefined) {
    return applyOutputLimit(base, resolved.maxOutputBytes, options.algorithm);
  }
  return base;
}

function resolveCompressionLimits(options: CompressionOptions): {
  maxOutputBytes?: bigint | number;
  maxCompressionRatio?: number;
  maxDictionaryBytes?: bigint | number;
  maxBufferedInputBytes?: number;
  maxBzip2BlockSize?: number;
} {
  const limits = options.limits as (ResourceLimits & {
    maxTotalUncompressedBytes?: bigint | number;
    maxDictionaryBytes?: bigint | number;
  });
  const resolved: {
    maxOutputBytes?: bigint | number;
    maxCompressionRatio?: number;
    maxDictionaryBytes?: bigint | number;
    maxBufferedInputBytes?: number;
    maxBzip2BlockSize?: number;
  } = {};
  const maxOutputBytes =
    options.maxOutputBytes ??
    limits?.maxTotalDecompressedBytes ??
    limits?.maxTotalUncompressedBytes;
  if (maxOutputBytes !== undefined) resolved.maxOutputBytes = maxOutputBytes;
  const maxCompressionRatio = options.maxCompressionRatio ?? limits?.maxCompressionRatio;
  if (maxCompressionRatio !== undefined) resolved.maxCompressionRatio = maxCompressionRatio;
  const maxDictionaryBytes =
    options.maxDictionaryBytes ??
    limits?.maxXzDictionaryBytes ??
    limits?.maxDictionaryBytes;
  if (maxDictionaryBytes !== undefined) resolved.maxDictionaryBytes = maxDictionaryBytes;
  const maxBufferedInputBytes = options.maxBufferedInputBytes ?? limits?.maxXzBufferedBytes;
  if (maxBufferedInputBytes !== undefined) resolved.maxBufferedInputBytes = maxBufferedInputBytes;
  if (limits?.maxBzip2BlockSize !== undefined) resolved.maxBzip2BlockSize = limits.maxBzip2BlockSize;
  return resolved;
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

function applyOutputLimit(
  transform: TransformStream<Uint8Array, Uint8Array>,
  maxBytes: bigint | number,
  algorithm: CompressionAlgorithm
): TransformStream<Uint8Array, Uint8Array> {
  const limit = toBigInt(maxBytes);
  const limiterState = { total: 0n };
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const nextTotal = limiterState.total + BigInt(chunk.length);
      if (nextTotal > limit) {
        throw new CompressionError('COMPRESSION_RESOURCE_LIMIT', 'Decompressed output exceeds limit', {
          algorithm,
          context: {
            limitBytes: limit.toString(),
            observedBytes: nextTotal.toString()
          }
        });
      }
      limiterState.total = nextTotal;
      controller.enqueue(chunk);
    }
  });
  return {
    readable: transform.readable.pipeThrough(limiter),
    writable: transform.writable
  } as TransformStream<Uint8Array, Uint8Array>;
}

function toBigInt(value: bigint | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
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
      const { reader: streamReader } = await ensure();
      const { value, done } = await streamReader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value) controller.enqueue(value);
    },
    async cancel(reason) {
      const { reader: streamReader } = await ensure();
      await streamReader.cancel(reason);
    }
  });

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      const { writer: streamWriter } = await ensure();
      await streamWriter.write(chunk);
    },
    async close() {
      const { writer: streamWriter } = await ensure();
      await streamWriter.close();
    },
    async abort(reason) {
      const { writer: streamWriter } = await ensure();
      await streamWriter.abort(reason);
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

type ProbeResult = { compress: boolean; decompress: boolean; backend: 'web' | 'none' };
type WebProbeResults = Record<CompressionAlgorithm, ProbeResult> & { note?: string };

async function probeWebCompression(): Promise<WebProbeResults> {
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
    return {
      gzip: { compress: false, decompress: false, backend: 'none' },
      deflate: { compress: false, decompress: false, backend: 'none' },
      'deflate-raw': { compress: false, decompress: false, backend: 'none' },
      brotli: { compress: false, decompress: false, backend: 'none' },
      zstd: { compress: false, decompress: false, backend: 'none' },
      bzip2: { compress: false, decompress: false, backend: 'none' },
      xz: { compress: false, decompress: false, backend: 'none' },
      note: 'CompressionStream not available in this runtime'
    };
  }
  const results: WebProbeResults = {
    gzip: { compress: false, decompress: false, backend: 'none' },
    deflate: { compress: false, decompress: false, backend: 'none' },
    'deflate-raw': { compress: false, decompress: false, backend: 'none' },
    brotli: { compress: false, decompress: false, backend: 'none' },
    zstd: { compress: false, decompress: false, backend: 'none' },
    bzip2: { compress: false, decompress: false, backend: 'none' },
    xz: { compress: false, decompress: false, backend: 'none' }
  };
  const algorithms: CompressionAlgorithm[] = ['gzip', 'deflate', 'deflate-raw', 'brotli', 'zstd'];
  for (const algorithm of algorithms) {
    const ok = await probeWebRoundtrip(algorithm);
    results[algorithm] = { compress: ok, decompress: ok, backend: ok ? 'web' : 'none' };
  }
  return results;
}

async function probeWebRoundtrip(algorithm: CompressionAlgorithm): Promise<boolean> {
  const payload = PROBE_PAYLOAD;
  try {
    const compressPair = new CompressionStream(algorithm as unknown as CompressionFormat) as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >;
    const decompressPair = new DecompressionStream(
      algorithm as unknown as CompressionFormat
    ) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
    const compressed = await collectStream(readableFromBytes(payload).pipeThrough(compressPair));
    const decompressed = await collectStream(readableFromBytes(compressed).pipeThrough(decompressPair));
    return bytesEqual(payload, decompressed);
  } catch {
    return false;
  }
}

function probeNodeCompression(algorithm: CompressionAlgorithm): { compress: boolean; decompress: boolean } | null {
  const binding = getNodeZlibBinding();
  if (!binding) return null;
  if (algorithm === 'gzip' || algorithm === 'deflate' || algorithm === 'deflate-raw') {
    const ok = 'Zlib' in binding;
    return { compress: ok, decompress: ok };
  }
  if (algorithm === 'brotli') {
    const ok = 'BrotliEncoder' in binding && 'BrotliDecoder' in binding;
    return { compress: ok, decompress: ok };
  }
  if (algorithm === 'zstd') {
    const ok = 'ZstdCompress' in binding && 'ZstdDecompress' in binding;
    return { compress: ok, decompress: ok };
  }
  return null;
}

function getNodeZlibBinding(): Record<string, unknown> | null {
  if (typeof process === 'undefined' || !process.versions?.node) return null;
  const bindingFn = (process as unknown as { binding?: (name: string) => unknown }).binding;
  if (!bindingFn) return null;
  try {
    const binding = bindingFn.call(process, 'zlib');
    if (binding && typeof binding === 'object') return binding as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

function readableFromBytes(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  });
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatChunks(chunks);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
