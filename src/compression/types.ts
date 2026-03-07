/** Readable/writable pair used by ZIP compression codecs. */
export type ZipCompressionStream = ReadableWritablePair<Uint8Array, Uint8Array>;

/** Options for ZIP decompression streams. */
export type ZipDecompressionOptions = {
  /** Abort signal for canceling codec setup or stream processing. */
  signal?: AbortSignal;
};

/** Options for ZIP compression streams. */
export type ZipCompressionOptions = {
  /** Abort signal for canceling codec setup or stream processing. */
  signal?: AbortSignal;
};

/** Codec interface for ZIP compression methods. */
export type ZipCompressionCodec = {
  /** ZIP method identifier emitted into local headers and the central directory. */
  methodId: number;
  /** Human-readable codec label used for diagnostics and capability reports. */
  name: string;
  /** Whether the codec can operate incrementally on web streams. */
  supportsStreaming: boolean;
  /** Creates a decompression stream for this codec. */
  createDecompressStream(options?: ZipDecompressionOptions): ZipCompressionStream | Promise<ZipCompressionStream>;
  /** Creates a compression stream for this codec when encoding is supported. */
  createCompressStream?(options?: ZipCompressionOptions): ZipCompressionStream | Promise<ZipCompressionStream>;
};
