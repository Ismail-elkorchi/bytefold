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
  /** Pipeline stage producing the progress callback. */
  kind: 'read' | 'write' | 'extract' | 'compress' | 'decrypt' | 'encrypt';
  /** Entry name when progress maps to a single member. */
  entryName?: string;
  /** Input bytes consumed by the active stage. */
  bytesIn?: bigint;
  /** Output bytes produced by the active stage. */
  bytesOut?: bigint;
  /** Total source bytes processed so far. */
  totalIn?: bigint;
  /** Total output bytes produced so far. */
  totalOut?: bigint;
};

/** Progress callback and throttling options. */
export type ZipProgressOptions = {
  /** Callback invoked with bounded progress events during read/write pipelines. */
  onProgress?: (event: ZipProgressEvent) => void;
  /** Minimum wall-clock interval between emitted progress callbacks. */
  progressIntervalMs?: number;
  /** Minimum chunk count between emitted progress callbacks. */
  progressChunkInterval?: number;
};

/** Severity level for ZIP issues. */
export type ZipIssueSeverity = 'info' | 'warning' | 'error';

/** A single issue found during audit or normalize. */
export type ZipIssue = {
  /** Stable machine code for policy filtering. */
  code: string;
  /** Severity for machine/human reporting. */
  severity: ZipIssueSeverity;
  /** Human-readable description of the issue. */
  message: string;
  /** Entry name when the issue maps to one file. */
  entryName?: string;
  /** Byte offset when parser metadata is available. */
  offset?: string;
  /** Additional structured context for automation. */
  details?: Record<string, unknown>;
};

/** Audit report for a ZIP archive. */
export type ZipAuditReport = {
  /** Stable schema version for JSON consumers. */
  schemaVersion: string;
  /** True when no error-severity issues are present. */
  ok: boolean;
  /** Aggregate entry/error counters for dashboards and policy decisions. */
  summary: {
    /** Number of entries found in central directory traversal. */
    entries: number;
    /** Number of entries using ZIP encryption metadata. */
    encryptedEntries: number;
    /** Entries requiring unsupported features/codecs. */
    unsupportedEntries: number;
    /** Warning issue count. */
    warnings: number;
    /** Error issue count. */
    errors: number;
    /** Bytes trailing the canonical ZIP payload, when present. */
    trailingBytes?: number;
  };
  /** Full issue list with stable machine codes. */
  issues: ZipIssue[];
  /** JSON-safe serializer used by report schema tests. */
  toJSON?: () => unknown;
};

/** ZIP entry metadata exposed by ZipReader. */
export type ZipEntry = {
  /** Normalized entry path. */
  name: string;
  /** Decoding strategy used for `name`. */
  nameSource: 'utf8-flag' | 'cp437' | 'unicode-extra';
  /** Original raw filename bytes from the archive. */
  rawNameBytes: Uint8Array;
  /** Optional entry comment. */
  comment?: string | undefined;
  /** Compression method identifier from ZIP headers. */
  method: number;
  /** Raw general-purpose bit flags. */
  flags: number;
  /** CRC32 value from ZIP metadata. */
  crc32: number;
  /** Stored compressed entry size. */
  compressedSize: bigint;
  /** Stored uncompressed entry size. */
  uncompressedSize: bigint;
  /** Byte offset to local header. */
  offset: bigint;
  /** Modified timestamp converted to `Date`. */
  mtime: Date;
  /** Access time when available. */
  atime?: Date | undefined;
  /** Creation time when available. */
  ctime?: Date | undefined;
  /** True when the entry is a directory marker. */
  isDirectory: boolean;
  /** True when the entry is a symlink. */
  isSymlink: boolean;
  /** True when encrypted metadata is present. */
  encrypted: boolean;
  /** True when ZIP64 metadata is used. */
  zip64: boolean;
};

/** Non-fatal warning produced while parsing ZIP structures. */
export type ZipWarning = {
  /** Stable machine-readable warning code. */
  code: string;
  /** Human-readable warning summary. */
  message: string;
  /** Entry name tied to the warning when it applies to one member. */
  entryName?: string;
};

/** Limits used when reading or extracting ZIP archives. */
export type ZipLimits = ResourceLimits;

/** Options for creating ZipReader instances. */
export type ZipReaderOptions = {
  /** Safety profile controlling strict defaults. */
  profile?: ZipProfile;
  /** Explicit strict-mode override. */
  isStrict?: boolean;
  /** Retain parsed entries in memory for repeated access. */
  shouldStoreEntries?: boolean;
  /** Resource ceilings for read/decompress/extract paths. */
  limits?: ZipLimits;
  /** Default password for encrypted entries. */
  password?: string;
  /** Abort signal for reader-level operations. */
  signal?: AbortSignal;
  /** HTTP range-read tuning for remote ZIP inputs opened from URLs. */
  http?: {
    /** Additional HTTP headers for remote ZIP requests. */
    headers?: Record<string, string>;
    /** In-memory block cache sizing for range reads. */
    cache?: { blockSize?: number; maxBlocks?: number };
    /** Abort signal for HTTP requests. */
    signal?: AbortSignal;
    /** Validator policy for conditional range requests. */
    snapshotPolicy?: 'require-strong-etag' | 'best-effort';
  };
};

/** Options for opening ZIP entries. */
export type ZipReaderOpenOptions = ZipProgressOptions & {
  /** Explicit strict-mode override. */
  isStrict?: boolean;
  /** Password override for this open call. */
  password?: string;
  /** Abort signal for the open stream pipeline. */
  signal?: AbortSignal;
};

/** Options for extracting ZIP entries. */
export type ZipExtractOptions = ZipProgressOptions & {
  /** Explicit strict-mode override. */
  isStrict?: boolean;
  /** Allow materializing symlinks that remain contained under the extraction root. */
  shouldAllowSymlinks?: boolean;
  /** Extraction resource ceilings. */
  limits?: ZipLimits;
  /** Password override for extraction. */
  password?: string;
  /** Abort signal for extraction operations. */
  signal?: AbortSignal;
};

/** Options for iterating ZIP entries. */
export type ZipReaderIterOptions = {
  signal?: AbortSignal;
};

/** Options for auditing ZIP archives. */
export type ZipAuditOptions = {
  /** Safety profile controlling strict defaults. */
  profile?: ZipProfile;
  /** Explicit strict-mode override. */
  isStrict?: boolean;
  /** Audit resource ceilings. */
  limits?: ZipLimits;
  /** Abort signal for audit operations. */
  signal?: AbortSignal;
};

/** Options for creating ZipWriter instances. */
export type ZipWriterOptions = ZipProgressOptions & {
  /** Force ZIP64 metadata regardless of payload size. */
  shouldForceZip64?: boolean;
  /** Default compression method for added entries. */
  defaultMethod?: CompressionMethod;
  /** Seekability policy for output sink optimization. */
  sinkSeekabilityPolicy?: 'auto' | 'on' | 'off';
  /** Default encryption mode for new entries. */
  encryption?: ZipEncryption;
  /** Password used when encryption needs credentials. */
  password?: string;
  /** Abort signal for writer lifecycle operations. */
  signal?: AbortSignal;
};

/** ZIP64 behavior for writing entries. */
export type Zip64Mode = 'auto' | 'force' | 'off';

/** Options for adding entries with ZipWriter. */
export type ZipWriterAddOptions = {
  /** Compression method override for this entry. */
  method?: CompressionMethod;
  /** Modified timestamp for the entry metadata. */
  mtime?: Date;
  /** Optional entry comment. */
  comment?: string;
  /** ZIP64 mode override for this entry. */
  zip64?: Zip64Mode;
  /** External file attribute bits. */
  externalAttributes?: number;
  /** Encryption mode override for this entry. */
  encryption?: ZipEncryption;
  /** Password override for this entry. */
  password?: string;
  /** Abort signal for this add call. */
  signal?: AbortSignal;
};

/** Options for closing ZipWriter. */
export type ZipWriterCloseOptions = {
  /** Abort signal for final central-directory and footer writes. */
  signal?: AbortSignal;
};

/** Normalization safety level. */
export type ZipNormalizeMode = 'safe' | 'lossless';

/** Conflict resolution for duplicate or colliding entries. */
export type ZipNormalizeConflict = 'error' | 'last-wins' | 'rename';

/** Options for normalizing ZIP archives. */
export type ZipNormalizeOptions = ZipProgressOptions & {
  /** Safe (drop-risky) or lossless normalization strategy. */
  mode?: ZipNormalizeMode;
  /** Enable deterministic output ordering and metadata shape. */
  isDeterministic?: boolean;
  /** Compression method applied to rewritten entries. */
  method?: CompressionMethod;
  /** Duplicate-entry conflict policy. */
  onDuplicate?: ZipNormalizeConflict;
  /** Case-collision policy for entry names. */
  onCaseCollision?: ZipNormalizeConflict;
  /** Handling policy for unsupported entry features. */
  onUnsupported?: 'error' | 'drop';
  /** Handling policy for symlink entries. */
  onSymlink?: 'error' | 'drop';
  /** Preserve entry comments in normalized output. */
  shouldPreserveComments?: boolean;
  /** Preserve trailing bytes after canonical ZIP payload. */
  shouldPreserveTrailingBytes?: boolean;
  /** Password used for encrypted entry reads. */
  password?: string;
  /** Normalization resource ceilings. */
  limits?: ZipLimits;
  /** Abort signal for normalize pipelines. */
  signal?: AbortSignal;
};

/** Normalize report for ZIP archives. */
export type ZipNormalizeReport = {
  /** Stable schema version for JSON consumers. */
  schemaVersion: string;
  /** True when normalize completed without error-severity issues. */
  ok: boolean;
  /** Aggregate counters describing what normalization preserved, rewrote, or dropped. */
  summary: ZipAuditReport['summary'] & {
    /** Number of entries emitted after normalization. */
    outputEntries: number;
    /** Entries dropped by normalize policy. */
    droppedEntries: number;
    /** Entries renamed to resolve conflicts. */
    renamedEntries: number;
    /** Entries recompressed during rewrite. */
    recompressedEntries: number;
    /** Entries preserved byte-for-byte. */
    preservedEntries: number;
  };
  /** Full issue list with stable machine codes. */
  issues: ZipIssue[];
  /** JSON-safe serializer used by report schema tests. */
  toJSON?: () => unknown;
};
