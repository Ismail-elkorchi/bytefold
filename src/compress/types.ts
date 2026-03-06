import type { ResourceLimits } from '../limits.js';
export type { ResourceLimits } from '../limits.js';

/** Supported compression algorithms. */
export type CompressionAlgorithm = 'gzip' | 'deflate' | 'deflate-raw' | 'brotli' | 'zstd' | 'bzip2' | 'xz';

/** Backend used for compression/decompression in the current runtime. */
export type CompressionBackend = 'web' | 'node-zlib' | 'pure-js' | 'none';

/** Progress event for compression/decompression streams. */
export type CompressionProgressEvent = {
  /** Pipeline direction emitting the event. */
  kind: 'compress' | 'decompress';
  /** Algorithm associated with the active transform. */
  algorithm: CompressionAlgorithm;
  /** Source bytes consumed so far. */
  bytesIn: bigint;
  /** Output bytes produced so far. */
  bytesOut: bigint;
};

/** Safety profile for compression checks. */
export type CompressionProfile = 'compat' | 'strict' | 'agent';

/** Options for creating compressors/decompressors. */
export type CompressionOptions = {
  /** Compression algorithm for the transform pipeline. */
  algorithm: CompressionAlgorithm;
  /** Abort signal for stream setup and processing. */
  signal?: AbortSignal;
  /** Progress callback for byte counters per stage. */
  onProgress?: (ev: CompressionProgressEvent) => void;
  /** Generic compression level hint for codec backends. */
  level?: number;
  /** Quality hint used by codecs that expose quality knobs. */
  quality?: number;
  /** Maximum output bytes allowed from the transform. */
  maxOutputBytes?: bigint | number;
  /** Maximum permitted output/input expansion ratio. */
  maxCompressionRatio?: number;
  /** Maximum dictionary bytes allowed by codec backends. */
  maxDictionaryBytes?: bigint | number;
  /** Maximum buffered input bytes for streaming decoders. */
  maxBufferedInputBytes?: number;
  /** Shared resource ceilings reused from archive limits. */
  limits?: ResourceLimits;
  /** Safety profile controlling strict default ceilings. */
  profile?: CompressionProfile;
};

/** Runtime compression capabilities report. */
export type CompressionCapabilities = {
  /** Stable JSON schema version for capability payloads. */
  schemaVersion: string;
  /** Runtime family where capability probing executed. */
  runtime: 'node' | 'deno' | 'bun' | 'web' | 'unknown';
  /** Per-algorithm compress/decompress support and backend source. */
  algorithms: Record<
    CompressionAlgorithm,
    {
      /** True when compression is supported for this algorithm. */
      compress: boolean;
      /** True when decompression is supported for this algorithm. */
      decompress: boolean;
      /** Backend providing the reported support. */
      backend: CompressionBackend;
    }
  >;
  /** Supplemental notes describing gating/compatibility details. */
  notes: string[];
};
