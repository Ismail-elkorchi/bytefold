import type {
  ArchiveAuditReport,
  ArchiveIssue,
  ArchiveLimits,
  ArchiveNormalizeReport,
  ArchiveProfile
} from '../archive/types.js';

/** TAR entry type identifiers. */
export type TarEntryType =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'link'
  | 'character'
  | 'block'
  | 'fifo'
  | 'unknown';

/** TAR entry metadata exposed by TarReader. */
export type TarEntry = {
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
};

/** TAR issue type (alias of archive issues). */
export type TarIssue = ArchiveIssue;
/** TAR audit report (alias of archive audit report). */
export type TarAuditReport = ArchiveAuditReport;
/** TAR normalize report (alias of archive normalize report). */
export type TarNormalizeReport = ArchiveNormalizeReport;

/** Options for creating TarReader instances. */
export type TarReaderOptions = {
  profile?: ArchiveProfile;
  isStrict?: boolean;
  limits?: ArchiveLimits;
  shouldStoreEntries?: boolean;
  signal?: AbortSignal;
};

/** Options for auditing TAR archives. */
export type TarAuditOptions = {
  profile?: ArchiveProfile;
  isStrict?: boolean;
  limits?: ArchiveLimits;
  signal?: AbortSignal;
};

/** Options for normalizing TAR archives. */
export type TarNormalizeOptions = {
  isDeterministic?: boolean;
  onDuplicate?: 'error' | 'last-wins' | 'rename';
  onCaseCollision?: 'error' | 'last-wins' | 'rename';
  onSymlink?: 'error' | 'drop';
  onUnsupported?: 'error' | 'drop';
  limits?: ArchiveLimits;
  signal?: AbortSignal;
};

/** Options for creating TarWriter instances. */
export type TarWriterOptions = {
  isDeterministic?: boolean;
  signal?: AbortSignal;
};

/** Options for adding entries with TarWriter. */
export type TarWriterAddOptions = {
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
};
