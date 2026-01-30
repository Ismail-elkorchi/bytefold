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
    return createDecompressTransform({
      algorithm: 'deflate-raw',
      signal: options?.signal
    });
  },
  async createCompressStream(options?: ZipCompressionOptions) {
    return createCompressTransform({
      algorithm: 'deflate-raw',
      signal: options?.signal
    });
  }
};

export const ZSTD_CODEC: ZipCompressionCodec = {
  methodId: 93,
  name: 'zstd',
  supportsStreaming: true,
  async createDecompressStream(options?: ZipDecompressionOptions) {
    try {
      return await createDecompressTransform({
        algorithm: 'zstd',
        signal: options?.signal
      });
    } catch (err) {
      throw new ZipError('ZIP_ZSTD_UNAVAILABLE', 'Zstandard support is not available in this runtime', {
        cause: err
      });
    }
  },
  async createCompressStream(options?: ZipCompressionOptions) {
    try {
      return await createCompressTransform({
        algorithm: 'zstd',
        signal: options?.signal
      });
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
