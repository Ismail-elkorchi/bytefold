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
  /** Normalized entry path. */
  name: string;
  /** Entry payload size in bytes. */
  size: bigint;
  /** Modified timestamp when present in headers. */
  mtime?: Date;
  /** POSIX permission/mode bits. */
  mode?: number;
  /** Owning user id when present. */
  uid?: number;
  /** Owning group id when present. */
  gid?: number;
  /** TAR header entry type. */
  type: TarEntryType;
  /** Link target for hard/symbolic links. */
  linkName?: string;
  /** True when the entry is a directory marker. */
  isDirectory: boolean;
  /** True when the entry is a symbolic link. */
  isSymlink: boolean;
  /** Parsed PAX key-value metadata. */
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
  /** Safety profile controlling strict defaults and limits. */
  profile?: ArchiveProfile;
  /** Explicit strict-mode override. */
  isStrict?: boolean;
  /** Resource ceilings for parse/audit/read paths. */
  limits?: ArchiveLimits;
  /** Keep parsed entries cached for repeated access. */
  shouldStoreEntries?: boolean;
  /** Abort signal for reader operations. */
  signal?: AbortSignal;
};

/** Options for auditing TAR archives. */
export type TarAuditOptions = {
  /** Safety profile controlling strict defaults and limits. */
  profile?: ArchiveProfile;
  /** Explicit strict-mode override. */
  isStrict?: boolean;
  /** Resource ceilings for audit operations. */
  limits?: ArchiveLimits;
  /** Abort signal for audit operations. */
  signal?: AbortSignal;
};

/** Options for normalizing TAR archives. */
export type TarNormalizeOptions = {
  /** Enable deterministic output ordering/metadata shape. */
  isDeterministic?: boolean;
  /** Duplicate-name handling policy. */
  onDuplicate?: 'error' | 'last-wins' | 'rename';
  /** Case-collision handling policy. */
  onCaseCollision?: 'error' | 'last-wins' | 'rename';
  /** Symlink handling policy during normalization. */
  onSymlink?: 'error' | 'drop';
  /** Unsupported-feature handling policy. */
  onUnsupported?: 'error' | 'drop';
  /** Resource ceilings for normalize operations. */
  limits?: ArchiveLimits;
  /** Abort signal for normalize operations. */
  signal?: AbortSignal;
};

/** Options for creating TarWriter instances. */
export type TarWriterOptions = {
  /** Enable deterministic entry metadata/order defaults. */
  isDeterministic?: boolean;
  /** Abort signal for writer operations. */
  signal?: AbortSignal;
};

/** Options for adding entries with TarWriter. */
export type TarWriterAddOptions = {
  /** Override TAR entry type for this member. */
  type?: TarEntryType;
  /** Modified timestamp written to headers. */
  mtime?: Date;
  /** POSIX mode bits written to headers. */
  mode?: number;
  /** User id written to headers. */
  uid?: number;
  /** Group id written to headers. */
  gid?: number;
  /** Link target path for link entry types. */
  linkName?: string;
  /** Optional size hint for streaming sources. */
  size?: bigint;
  /** User name written to headers when available. */
  uname?: string;
  /** Group name written to headers when available. */
  gname?: string;
  /** Additional PAX metadata fields. */
  pax?: Record<string, string>;
};
