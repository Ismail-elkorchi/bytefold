export type ArchiveFormat = 'zip' | 'tar' | 'gz' | 'tgz';
export type ArchiveProfile = 'compat' | 'strict' | 'agent';
export type ArchiveIssueSeverity = 'info' | 'warning' | 'error';

export interface ArchiveIssue {
  code: string;
  severity: ArchiveIssueSeverity;
  message: string;
  entryName?: string;
  offset?: bigint;
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
  zip?: Record<string, unknown>;
  tar?: Record<string, unknown>;
}
