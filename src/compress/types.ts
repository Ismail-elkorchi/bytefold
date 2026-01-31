export type CompressionAlgorithm = 'gzip' | 'deflate' | 'deflate-raw' | 'brotli' | 'zstd';

export type CompressionBackend = 'web' | 'node-zlib' | 'none';

export type CompressionProgressEvent = {
  kind: 'compress' | 'decompress';
  algorithm: CompressionAlgorithm;
  bytesIn: bigint;
  bytesOut: bigint;
};

export interface CompressionOptions {
  algorithm: CompressionAlgorithm;
  signal?: AbortSignal;
  onProgress?: (ev: CompressionProgressEvent) => void;
  level?: number;
  quality?: number;
}

export type CompressionCapabilities = {
  runtime: 'node' | 'deno' | 'bun' | 'unknown';
  algorithms: Record<
    CompressionAlgorithm,
    { compress: boolean; decompress: boolean; backend: CompressionBackend }
  >;
  notes: string[];
};
