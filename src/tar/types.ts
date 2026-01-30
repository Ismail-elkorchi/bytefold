import type {
  ArchiveAuditReport,
  ArchiveIssue,
  ArchiveLimits,
  ArchiveNormalizeReport,
  ArchiveProfile
} from '../archive/types.js';

export type TarEntryType =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'link'
  | 'character'
  | 'block'
  | 'fifo'
  | 'unknown';

export interface TarEntry {
  name: string;
  size: bigint;
  mtime?: Date;
  mode?: number;
  uid?: number;
  gid?: number;
  type: TarEntryType;
  linkName?: string;
  isDirectory: boolean;
  isSymlink: boolean;
  pax?: Record<string, string>;
}

export type TarIssue = ArchiveIssue;
export type TarAuditReport = ArchiveAuditReport;
export type TarNormalizeReport = ArchiveNormalizeReport;

export interface TarReaderOptions {
  profile?: ArchiveProfile;
  strict?: boolean;
  limits?: ArchiveLimits;
  storeEntries?: boolean;
  signal?: AbortSignal;
}

export interface TarAuditOptions {
  profile?: ArchiveProfile;
  strict?: boolean;
  limits?: ArchiveLimits;
  signal?: AbortSignal;
}

export interface TarNormalizeOptions {
  deterministic?: boolean;
  onDuplicate?: 'error' | 'last-wins' | 'rename';
  onCaseCollision?: 'error' | 'last-wins' | 'rename';
  onSymlink?: 'error' | 'drop';
  onUnsupported?: 'error' | 'drop';
  signal?: AbortSignal;
}

export interface TarWriterOptions {
  deterministic?: boolean;
  signal?: AbortSignal;
}

export interface TarWriterAddOptions {
  type?: TarEntryType;
  mtime?: Date;
  mode?: number;
  uid?: number;
  gid?: number;
  linkName?: string;
  size?: bigint;
  uname?: string;
  gname?: string;
  pax?: Record<string, string>;
}
