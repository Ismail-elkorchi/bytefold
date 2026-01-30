export type CompressionMethod = 0 | 8 | 93;

export interface ZipEntry {
  name: string;
  nameSource: 'utf8-flag' | 'cp437' | 'unicode-extra';
  rawNameBytes: Uint8Array;
  comment?: string | undefined;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: bigint;
  uncompressedSize: bigint;
  offset: bigint;
  mtime: Date;
  atime?: Date | undefined;
  ctime?: Date | undefined;
  isDirectory: boolean;
  isSymlink: boolean;
  encrypted: boolean;
  zip64: boolean;
}

export interface ZipWarning {
  code: string;
  message: string;
  entryName?: string;
}

export interface ZipLimits {
  maxEntries?: number;
  maxUncompressedEntryBytes?: bigint | number;
  maxTotalUncompressedBytes?: bigint | number;
  maxCompressionRatio?: number;
}

export interface ZipReaderOptions {
  strict?: boolean;
  limits?: ZipLimits;
  http?: {
    headers?: Record<string, string>;
    cache?: { blockSize?: number; maxBlocks?: number };
    signal?: AbortSignal;
  };
}

export interface ZipReaderOpenOptions {
  strict?: boolean;
}

export interface ZipExtractOptions {
  strict?: boolean;
  allowSymlinks?: boolean;
  limits?: ZipLimits;
}

export interface ZipWriterOptions {
  forceZip64?: boolean;
  defaultMethod?: CompressionMethod;
  seekable?: 'auto' | 'on' | 'off';
}

export type Zip64Mode = 'auto' | 'force' | 'off';

export interface ZipWriterAddOptions {
  method?: CompressionMethod;
  mtime?: Date;
  comment?: string;
  zip64?: Zip64Mode;
  externalAttributes?: number;
}
