import type { CompressionAlgorithm } from '../compress/types.js';
import type { ResourceLimits } from '../limits.js';
export type { ResourceLimits } from '../limits.js';

/** Supported archive and compression format identifiers. */
export type ArchiveFormat =
  | 'zip'
  | 'tar'
  | 'gz'
  | 'tgz'
  | 'tar.gz'
  | 'bz2'
  | 'tar.bz2'
  | 'zst'
  | 'br'
  | 'tar.zst'
  | 'tar.br'
  | 'xz'
  | 'tar.xz';
/** Safety profile for audit/normalize behavior. */
export type ArchiveProfile = 'compat' | 'strict' | 'agent';
/** Severity level for archive issues. */
export type ArchiveIssueSeverity = 'info' | 'warning' | 'error';
/** How the archive input was provided. */
export type ArchiveInputKind = 'file' | 'url' | 'bytes' | 'stream' | 'blob';

/** Detection report for layered archives and compression. */
export type ArchiveDetectionReport = {
  /** Stable schema version for JSON consumers. */
  schemaVersion: string;
  /** How the caller supplied input bytes/stream/blob/path/url. */
  inputKind: ArchiveInputKind;
  /** Container/compression detection details. */
  detected: {
    /** Container kind when present (`zip`/`tar`). */
    container?: 'zip' | 'tar';
    /** Compression layer when present (`gzip`/`xz`/etc.). */
    compression?: CompressionAlgorithm | 'none';
    /** Ordered container/compression labels describing the full stack. */
    layers: string[];
  };
  /** Confidence score for detection source (`forced`, filename hint, magic bytes). */
  confidence: 'high' | 'medium' | 'low';
  /** Supplemental notes describing how detection concluded. */
  notes: string[];
};

/** A single audit/normalize issue found in an archive. */
export type ArchiveIssue = {
  /** Stable machine code for filtering and alerting. */
  code: string;
  /** Severity for policy decisions (`info`/`warning`/`error`). */
  severity: ArchiveIssueSeverity;
  /** Human-readable explanation of the issue. */
  message: string;
  /** Entry path when the issue is tied to one archive member. */
  entryName?: string;
  /** Byte offset string when available from parser state. */
  offset?: string;
  /** Additional structured context for machine consumers. */
  details?: Record<string, unknown>;
};

/** Audit summary for an archive. */
export type ArchiveAuditReport = {
  /** Stable schema version for JSON consumers. */
  schemaVersion: string;
  /** True when no error-severity issues are present. */
  ok: boolean;
  /** Aggregate counts from the audit pass. */
  summary: {
    /** Number of entries observed in the archive. */
    entries: number;
    /** Count of warning-severity issues. */
    warnings: number;
    /** Count of error-severity issues. */
    errors: number;
    /** Total payload bytes when available. */
    totalBytes?: number;
  };
  /** Full issue list with stable machine codes. */
  issues: ArchiveIssue[];
  /** JSON-safe serializer used by report schema tests. */
  toJSON?: () => unknown;
};

/** Normalize summary for an archive. */
export type ArchiveNormalizeReport = {
  /** Stable schema version for JSON consumers. */
  schemaVersion: string;
  /** True when normalize completed without error-severity issues. */
  ok: boolean;
  /** Aggregate counts from normalize output. */
  summary: {
    /** Number of input entries inspected. */
    entries: number;
    /** Number of entries emitted to normalized output. */
    outputEntries: number;
    /** Entries dropped by normalize policy. */
    droppedEntries: number;
    /** Entries renamed to resolve conflicts. */
    renamedEntries: number;
    /** Warning-severity issue count. */
    warnings: number;
    /** Error-severity issue count. */
    errors: number;
  };
  /** Full issue list with stable machine codes. */
  issues: ArchiveIssue[];
  /** JSON-safe serializer used by report schema tests. */
  toJSON?: () => unknown;
};

/** Limits for archive processing and validation. */
export type ArchiveLimits = ResourceLimits;

/** Normalized view of an archive entry. */
export type ArchiveEntry = {
  /** Entry format family used by this reader (`zip`, `tar`, etc.). */
  format: ArchiveFormat;
  /** Normalized entry path (forward-slash separators). */
  name: string;
  /** Uncompressed entry size in bytes. */
  size: bigint;
  /** True when the entry represents a directory. */
  isDirectory: boolean;
  /** True when the entry represents a symbolic link. */
  isSymlink: boolean;
  /** Entry modified time when present in source metadata. */
  mtime?: Date;
  /** Entry mode bits when present. */
  mode?: number;
  /** Entry uid when present. */
  uid?: number;
  /** Entry gid when present. */
  gid?: number;
  /** Symlink target path when entry is a link. */
  linkName?: string;
  /** Lazy stream opener for entry payload bytes. */
  open: () => Promise<ReadableStream<Uint8Array>>;
  /** Format-specific raw entry metadata for advanced tooling. */
  raw?: unknown;
};

/** Options for opening/detecting archives. */
export type ArchiveOpenOptions = {
  /** Force format or use `auto` detection (default). */
  format?: ArchiveFormat | 'auto';
  /** Safety profile used to resolve strict defaults and limits. */
  profile?: ArchiveProfile;
  /** Explicit strict-mode override. */
  isStrict?: boolean;
  /** Resource ceilings for input/decompression/extraction. */
  limits?: ArchiveLimits;
  /** Abort signal for open/detect/list pipelines. */
  signal?: AbortSignal;
  /** Password used for encrypted ZIP members. */
  password?: string;
  /** Filename hint used when byte-level detection is ambiguous. */
  filename?: string;
  /** Explicit input kind override for reporting. */
  inputKind?: ArchiveInputKind;
  /** ZIP-reader specific passthrough options. */
  zip?: Record<string, unknown>;
  /** TAR-reader specific passthrough options. */
  tar?: Record<string, unknown>;
};
