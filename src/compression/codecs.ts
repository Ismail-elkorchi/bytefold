import { Duplex } from 'node:stream';
import { createDeflateRaw, createInflateRaw, createZstdCompress, createZstdDecompress } from 'node:zlib';
import { ZipError } from '../errors.js';
import type { ZipCompressionCodec, ZipCompressionStream, ZipDecompressionOptions } from './types.js';
import { createDeflate64DecompressStream } from './deflate64.js';

function nodeDuplexToWeb(duplex: Duplex): ZipCompressionStream {
  const { readable, writable } = Duplex.toWeb(duplex);
  return {
    readable: readable as ReadableStream<Uint8Array>,
    writable: writable as WritableStream<Uint8Array>
  };
}

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
  createDecompressStream() {
    return nodeDuplexToWeb(createInflateRaw());
  },
  createCompressStream() {
    return nodeDuplexToWeb(createDeflateRaw());
  }
};

export const ZSTD_CODEC: ZipCompressionCodec = {
  methodId: 93,
  name: 'zstd',
  supportsStreaming: true,
  createDecompressStream() {
    if (typeof createZstdDecompress !== 'function') {
      throw new ZipError('ZIP_ZSTD_UNAVAILABLE', 'Zstandard support is not available in this Node runtime');
    }
    return nodeDuplexToWeb(createZstdDecompress());
  },
  createCompressStream() {
    if (typeof createZstdCompress !== 'function') {
      throw new ZipError('ZIP_ZSTD_UNAVAILABLE', 'Zstandard support is not available in this Node runtime');
    }
    return nodeDuplexToWeb(createZstdCompress());
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
