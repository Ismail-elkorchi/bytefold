import type { CompressionAlgorithm } from '../compress/types.js';

export type ArchiveFormat =
  | 'zip'
  | 'tar'
  | 'gz'
  | 'tgz'
  | 'tar.gz'
  | 'zst'
  | 'br'
  | 'tar.zst'
  | 'tar.br';
export type ArchiveProfile = 'compat' | 'strict' | 'agent';
export type ArchiveIssueSeverity = 'info' | 'warning' | 'error';
export type ArchiveInputKind = 'file' | 'url' | 'bytes' | 'stream';

export interface ArchiveDetectionReport {
  inputKind: ArchiveInputKind;
  detected: {
    container?: 'zip' | 'tar';
    compression?: CompressionAlgorithm | 'none';
    layers: string[];
  };
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

export interface ArchiveIssue {
  code: string;
  severity: ArchiveIssueSeverity;
  message: string;
  entryName?: string;
  offset?: string;
  details?: Record<string, unknown>;
}

export interface ArchiveAuditReport {
  ok: boolean;
  summary: {
    entries: number;
    warnings: number;
    errors: number;
    totalBytes?: number;
  };
  issues: ArchiveIssue[];
  toJSON?: () => unknown;
}

export interface ArchiveNormalizeReport {
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
}

export interface ArchiveLimits {
  maxEntries?: number;
  maxUncompressedEntryBytes?: bigint | number;
  maxTotalUncompressedBytes?: bigint | number;
  maxCompressionRatio?: number;
}

export interface ArchiveEntry {
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
}

export interface ArchiveOpenOptions {
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
}
