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
export type ArchiveInputKind = 'file' | 'url' | 'bytes' | 'stream';

/** Detection report for layered archives and compression. */
export type ArchiveDetectionReport = {
  schemaVersion: string;
  inputKind: ArchiveInputKind;
  detected: {
    container?: 'zip' | 'tar';
    compression?: CompressionAlgorithm | 'none';
    layers: string[];
  };
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
};

/** A single audit/normalize issue found in an archive. */
export type ArchiveIssue = {
  code: string;
  severity: ArchiveIssueSeverity;
  message: string;
  entryName?: string;
  offset?: string;
  details?: Record<string, unknown>;
};

/** Audit summary for an archive. */
export type ArchiveAuditReport = {
  schemaVersion: string;
  ok: boolean;
  summary: {
    entries: number;
    warnings: number;
    errors: number;
    totalBytes?: number;
  };
  issues: ArchiveIssue[];
  toJSON?: () => unknown;
};

/** Normalize summary for an archive. */
export type ArchiveNormalizeReport = {
  schemaVersion: string;
  ok: boolean;
  summary: {
    entries: number;
    outputEntries: number;
    droppedEntries: number;
    renamedEntries: number;
    warnings: number;
    errors: number;
  };
  issues: ArchiveIssue[];
  toJSON?: () => unknown;
};

/** Limits for archive processing and validation. */
export type ArchiveLimits = ResourceLimits;

/** Normalized view of an archive entry. */
export type ArchiveEntry = {
  format: ArchiveFormat;
  name: string;
  size: bigint;
  isDirectory: boolean;
  isSymlink: boolean;
  mtime?: Date;
  mode?: number;
  uid?: number;
  gid?: number;
  linkName?: string;
  open: () => Promise<ReadableStream<Uint8Array>>;
  raw?: unknown;
};

/** Options for opening/detecting archives. */
export type ArchiveOpenOptions = {
  format?: ArchiveFormat | 'auto';
  profile?: ArchiveProfile;
  strict?: boolean;
  limits?: ArchiveLimits;
  signal?: AbortSignal;
  password?: string;
  filename?: string;
  inputKind?: ArchiveInputKind;
  zip?: Record<string, unknown>;
  tar?: Record<string, unknown>;
};
