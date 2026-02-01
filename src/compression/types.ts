/** Readable/writable pair used by ZIP compression codecs. */
export type ZipCompressionStream = ReadableWritablePair<Uint8Array, Uint8Array>;

/** Options for ZIP decompression streams. */
export type ZipDecompressionOptions = {
  signal?: AbortSignal;
};

/** Options for ZIP compression streams. */
export type ZipCompressionOptions = {
  signal?: AbortSignal;
};

/** Codec interface for ZIP compression methods. */
export type ZipCompressionCodec = {
  methodId: number;
  name: string;
  supportsStreaming: boolean;
  createDecompressStream(options?: ZipDecompressionOptions): ZipCompressionStream | Promise<ZipCompressionStream>;
  createCompressStream?(options?: ZipCompressionOptions): ZipCompressionStream | Promise<ZipCompressionStream>;
};
