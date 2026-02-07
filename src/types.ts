import type { ResourceLimits } from './limits.js';
export type { ResourceLimits } from './limits.js';

/** ZIP compression method identifiers. */
export type CompressionMethod = 0 | 8 | 9 | 93 | (number & {});

/** ZIP encryption configuration for reading/writing. */
export type ZipEncryption =
  | { type: 'none' }
  | { type: 'zipcrypto'; password: string }
  | { type: 'aes'; password: string; strength?: 128 | 192 | 256; vendorVersion?: 1 | 2 };

/** Safety profile for ZIP operations. */
export type ZipProfile = 'compat' | 'strict' | 'agent';

/** Progress event emitted by ZIP operations. */
export type ZipProgressEvent = {
  kind: 'read' | 'write' | 'extract' | 'compress' | 'decrypt' | 'encrypt';
  entryName?: string;
  bytesIn?: bigint;
  bytesOut?: bigint;
  totalIn?: bigint;
  totalOut?: bigint;
};

/** Progress callback and throttling options. */
export type ZipProgressOptions = {
  onProgress?: (event: ZipProgressEvent) => void;
  progressIntervalMs?: number;
  progressChunkInterval?: number;
};

/** Severity level for ZIP issues. */
export type ZipIssueSeverity = 'info' | 'warning' | 'error';

/** A single issue found during audit or normalize. */
export type ZipIssue = {
  code: string;
  severity: ZipIssueSeverity;
  message: string;
  entryName?: string;
  offset?: string;
  details?: Record<string, unknown>;
};

/** Audit report for a ZIP archive. */
export type ZipAuditReport = {
  schemaVersion: string;
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
  toJSON?: () => unknown;
};

/** ZIP entry metadata exposed by ZipReader. */
export type ZipEntry = {
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
};

/** Non-fatal warning produced while parsing ZIP structures. */
export type ZipWarning = {
  code: string;
  message: string;
  entryName?: string;
};

/** Limits used when reading or extracting ZIP archives. */
export type ZipLimits = ResourceLimits;

/** Options for creating ZipReader instances. */
export type ZipReaderOptions = {
  profile?: ZipProfile;
  isStrict?: boolean;
  shouldStoreEntries?: boolean;
  limits?: ZipLimits;
  password?: string;
  signal?: AbortSignal;
  http?: {
    headers?: Record<string, string>;
    cache?: { blockSize?: number; maxBlocks?: number };
    signal?: AbortSignal;
    snapshotPolicy?: 'require-strong-etag' | 'best-effort';
  };
};

/** Options for opening ZIP entries. */
export type ZipReaderOpenOptions = ZipProgressOptions & {
  isStrict?: boolean;
  password?: string;
  signal?: AbortSignal;
};

/** Options for extracting ZIP entries. */
export type ZipExtractOptions = ZipProgressOptions & {
  isStrict?: boolean;
  shouldAllowSymlinks?: boolean;
  limits?: ZipLimits;
  password?: string;
  signal?: AbortSignal;
};

/** Options for iterating ZIP entries. */
export type ZipReaderIterOptions = {
  signal?: AbortSignal;
};

/** Options for auditing ZIP archives. */
export type ZipAuditOptions = {
  profile?: ZipProfile;
  isStrict?: boolean;
  limits?: ZipLimits;
  signal?: AbortSignal;
};

/** Options for creating ZipWriter instances. */
export type ZipWriterOptions = ZipProgressOptions & {
  shouldForceZip64?: boolean;
  defaultMethod?: CompressionMethod;
  sinkSeekabilityPolicy?: 'auto' | 'on' | 'off';
  encryption?: ZipEncryption;
  password?: string;
  signal?: AbortSignal;
};

/** ZIP64 behavior for writing entries. */
export type Zip64Mode = 'auto' | 'force' | 'off';

/** Options for adding entries with ZipWriter. */
export type ZipWriterAddOptions = {
  method?: CompressionMethod;
  mtime?: Date;
  comment?: string;
  zip64?: Zip64Mode;
  externalAttributes?: number;
  encryption?: ZipEncryption;
  password?: string;
  signal?: AbortSignal;
};

/** Options for closing ZipWriter. */
export type ZipWriterCloseOptions = {
  signal?: AbortSignal;
};

/** Normalization safety level. */
export type ZipNormalizeMode = 'safe' | 'lossless';

/** Conflict resolution for duplicate or colliding entries. */
export type ZipNormalizeConflict = 'error' | 'last-wins' | 'rename';

/** Options for normalizing ZIP archives. */
export type ZipNormalizeOptions = ZipProgressOptions & {
  mode?: ZipNormalizeMode;
  isDeterministic?: boolean;
  method?: CompressionMethod;
  onDuplicate?: ZipNormalizeConflict;
  onCaseCollision?: ZipNormalizeConflict;
  onUnsupported?: 'error' | 'drop';
  onSymlink?: 'error' | 'drop';
  shouldPreserveComments?: boolean;
  shouldPreserveTrailingBytes?: boolean;
  password?: string;
  limits?: ZipLimits;
  signal?: AbortSignal;
};

/** Normalize report for ZIP archives. */
export type ZipNormalizeReport = {
  schemaVersion: string;
  ok: boolean;
  summary: ZipAuditReport['summary'] & {
    outputEntries: number;
    droppedEntries: number;
    renamedEntries: number;
    recompressedEntries: number;
    preservedEntries: number;
  };
  issues: ZipIssue[];
  toJSON?: () => unknown;
};
