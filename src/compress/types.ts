/** Supported compression algorithms. */
export type CompressionAlgorithm = 'gzip' | 'deflate' | 'deflate-raw' | 'brotli' | 'zstd';

/** Backend used for compression/decompression in the current runtime. */
export type CompressionBackend = 'web' | 'node-zlib' | 'none';

/** Progress event for compression/decompression streams. */
export type CompressionProgressEvent = {
  kind: 'compress' | 'decompress';
  algorithm: CompressionAlgorithm;
  bytesIn: bigint;
  bytesOut: bigint;
};

/** Options for creating compressors/decompressors. */
export type CompressionOptions = {
  algorithm: CompressionAlgorithm;
  signal?: AbortSignal;
  onProgress?: (ev: CompressionProgressEvent) => void;
  level?: number;
  quality?: number;
};

/** Runtime compression capabilities report. */
export type CompressionCapabilities = {
  schemaVersion: string;
  runtime: 'node' | 'deno' | 'bun' | 'unknown';
  algorithms: Record<
    CompressionAlgorithm,
    { compress: boolean; decompress: boolean; backend: CompressionBackend }
  >;
  notes: string[];
};
