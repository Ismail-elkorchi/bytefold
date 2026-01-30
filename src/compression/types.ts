export type ZipCompressionStream = ReadableWritablePair<Uint8Array, Uint8Array>;

export interface ZipDecompressionOptions {
  signal?: AbortSignal;
}

export interface ZipCompressionOptions {
  signal?: AbortSignal;
}

export interface ZipCompressionCodec {
  methodId: number;
  name: string;
  supportsStreaming: boolean;
  createDecompressStream(options?: ZipDecompressionOptions): ZipCompressionStream;
  createCompressStream?(options?: ZipCompressionOptions): ZipCompressionStream;
}
