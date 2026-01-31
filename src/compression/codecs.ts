import { ZipError } from '../errors.js';
import type { ZipCompressionCodec, ZipCompressionOptions, ZipCompressionStream, ZipDecompressionOptions } from './types.js';
import { createDeflate64DecompressStream } from './deflate64.js';
import { createCompressTransform, createDecompressTransform } from './streams.js';

function passthroughStream(): ZipCompressionStream {
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    }
  });
}

export const STORE_CODEC: ZipCompressionCodec = {
  methodId: 0,
  name: 'store',
  supportsStreaming: true,
  createDecompressStream() {
    return passthroughStream();
  },
  createCompressStream() {
    return passthroughStream();
  }
};

export const DEFLATE_CODEC: ZipCompressionCodec = {
  methodId: 8,
  name: 'deflate',
  supportsStreaming: true,
  async createDecompressStream(options?: ZipDecompressionOptions) {
    const opts = {
      algorithm: 'deflate-raw' as const,
      ...(options?.signal ? { signal: options.signal } : {})
    };
    return createDecompressTransform(opts);
  },
  async createCompressStream(options?: ZipCompressionOptions) {
    const opts = {
      algorithm: 'deflate-raw' as const,
      ...(options?.signal ? { signal: options.signal } : {})
    };
    return createCompressTransform(opts);
  }
};

export const ZSTD_CODEC: ZipCompressionCodec = {
  methodId: 93,
  name: 'zstd',
  supportsStreaming: true,
  async createDecompressStream(options?: ZipDecompressionOptions) {
    try {
      const opts = {
        algorithm: 'zstd' as const,
        ...(options?.signal ? { signal: options.signal } : {})
      };
      return await createDecompressTransform(opts);
    } catch (err) {
      throw new ZipError('ZIP_ZSTD_UNAVAILABLE', 'Zstandard support is not available in this runtime', {
        cause: err
      });
    }
  },
  async createCompressStream(options?: ZipCompressionOptions) {
    try {
      const opts = {
        algorithm: 'zstd' as const,
        ...(options?.signal ? { signal: options.signal } : {})
      };
      return await createCompressTransform(opts);
    } catch (err) {
      throw new ZipError('ZIP_ZSTD_UNAVAILABLE', 'Zstandard support is not available in this runtime', {
        cause: err
      });
    }
  }
};

export const DEFLATE64_CODEC: ZipCompressionCodec = {
  methodId: 9,
  name: 'deflate64',
  supportsStreaming: true,
  createDecompressStream(options?: ZipDecompressionOptions) {
    return createDeflate64DecompressStream(options);
  }
};
