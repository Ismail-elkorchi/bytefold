import { Duplex } from 'node:stream';
import {
  createBrotliCompress,
  createBrotliDecompress,
  createDeflate,
  createDeflateRaw,
  createGunzip,
  createGzip,
  createInflate,
  createInflateRaw,
  createZstdCompress,
  createZstdDecompress
} from 'node:zlib';
import type { CompressionAlgorithm, CompressionMode } from './streams.js';

function toWebTransform(duplex: Duplex, signal?: AbortSignal): ReadableWritablePair<Uint8Array, Uint8Array> {
  if (signal) {
    if (signal.aborted) {
      duplex.destroy(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    } else {
      signal.addEventListener(
        'abort',
        () => {
          duplex.destroy(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
        },
        { once: true }
      );
    }
  }
  const { readable, writable } = Duplex.toWeb(duplex);
  return {
    readable: readable as ReadableStream<Uint8Array>,
    writable: writable as WritableStream<Uint8Array>
  };
}

function supports(algorithm: CompressionAlgorithm, mode: CompressionMode): boolean {
  switch (algorithm) {
    case 'gzip':
      return true;
    case 'deflate-raw':
      return true;
    case 'deflate':
      return true;
    case 'brotli':
      return typeof createBrotliCompress === 'function' && typeof createBrotliDecompress === 'function';
    case 'zstd':
      if (mode === 'compress') {
        return typeof createZstdCompress === 'function';
      }
      return typeof createZstdDecompress === 'function';
    default: {
      const exhaustive: never = algorithm;
      return exhaustive;
    }
  }
}

function create(algorithm: CompressionAlgorithm, mode: CompressionMode, signal?: AbortSignal) {
  switch (algorithm) {
    case 'gzip': {
      const stream = mode === 'compress' ? createGzip() : createGunzip();
      return toWebTransform(stream, signal);
    }
    case 'deflate': {
      const stream = mode === 'compress' ? createDeflate() : createInflate();
      return toWebTransform(stream, signal);
    }
    case 'deflate-raw': {
      const stream = mode === 'compress' ? createDeflateRaw() : createInflateRaw();
      return toWebTransform(stream, signal);
    }
    case 'brotli': {
      if (!supports('brotli', mode)) {
        throw new Error('Brotli not supported in this Node runtime');
      }
      const stream = mode === 'compress' ? createBrotliCompress() : createBrotliDecompress();
      return toWebTransform(stream, signal);
    }
    case 'zstd': {
      if (!supports('zstd', mode)) {
        throw new Error('Zstandard not supported in this Node runtime');
      }
      const stream = mode === 'compress' ? createZstdCompress() : createZstdDecompress();
      return toWebTransform(stream, signal);
    }
    default: {
      const exhaustive: never = algorithm;
      return exhaustive;
    }
  }
}

export const nodeBackend = {
  supports,
  create
};
