export type CompressionMethod = 0 | 8 | 93;

export type ZipEncryption =
  | { type: 'none' }
  | { type: 'zipcrypto'; password: string }
  | { type: 'aes'; password: string; strength?: 128 | 192 | 256; vendorVersion?: 1 | 2 };

export type ZipProfile = 'compat' | 'strict' | 'agent';

export type ZipProgressEvent = {
  kind: 'read' | 'write' | 'extract' | 'compress' | 'decrypt' | 'encrypt';
  entryName?: string;
  bytesIn?: bigint;
  bytesOut?: bigint;
  totalIn?: bigint;
  totalOut?: bigint;
};

export interface ZipProgressOptions {
  onProgress?: (event: ZipProgressEvent) => void;
  progressIntervalMs?: number;
  progressChunkInterval?: number;
}

export type ZipIssueSeverity = 'info' | 'warning' | 'error';

export type ZipIssue = {
  code: string;
  severity: ZipIssueSeverity;
  message: string;
  entryName?: string;
  offset?: bigint;
  details?: Record<string, unknown>;
};

export type ZipAuditReport = {
  ok: boolean;
  summary: {
    entries: number;
    encryptedEntries: number;
    unsupportedEntries: number;
    warnings: number;
    errors: number;
    trailingBytes?: number;
  };
  issues: ZipIssue[];
};

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
  profile?: ZipProfile;
  strict?: boolean;
  storeEntries?: boolean;
  limits?: ZipLimits;
  password?: string;
  signal?: AbortSignal;
  http?: {
    headers?: Record<string, string>;
    cache?: { blockSize?: number; maxBlocks?: number };
    signal?: AbortSignal;
  };
}

export interface ZipReaderOpenOptions extends ZipProgressOptions {
  strict?: boolean;
  password?: string;
  signal?: AbortSignal;
}

export interface ZipExtractOptions extends ZipProgressOptions {
  strict?: boolean;
  allowSymlinks?: boolean;
  limits?: ZipLimits;
  password?: string;
  signal?: AbortSignal;
}

export interface ZipReaderIterOptions {
  signal?: AbortSignal;
}

export interface ZipAuditOptions {
  profile?: ZipProfile;
  strict?: boolean;
  limits?: ZipLimits;
  signal?: AbortSignal;
}

export interface ZipWriterOptions extends ZipProgressOptions {
  forceZip64?: boolean;
  defaultMethod?: CompressionMethod;
  seekable?: 'auto' | 'on' | 'off';
  encryption?: ZipEncryption;
  password?: string;
  signal?: AbortSignal;
}

export type Zip64Mode = 'auto' | 'force' | 'off';

export interface ZipWriterAddOptions {
  method?: CompressionMethod;
  mtime?: Date;
  comment?: string;
  zip64?: Zip64Mode;
  externalAttributes?: number;
  encryption?: ZipEncryption;
  password?: string;
  signal?: AbortSignal;
}

export interface ZipWriterCloseOptions {
  signal?: AbortSignal;
}
