/** Stable archive error codes. */
export type ArchiveErrorCode =
  | 'ARCHIVE_UNSUPPORTED_FORMAT'
  | 'ARCHIVE_TRUNCATED'
  | 'ARCHIVE_BAD_HEADER'
  | 'ARCHIVE_PATH_TRAVERSAL'
  | 'ARCHIVE_LIMIT_EXCEEDED'
  | 'ARCHIVE_UNSUPPORTED_FEATURE'
  | 'ARCHIVE_AUDIT_FAILED';

/** Error thrown for archive-level failures and safety violations. */
export class ArchiveError extends Error {
  /** Machine-readable error code. */
  readonly code: ArchiveErrorCode;
  /** Entry name related to the error, if available. */
  readonly entryName?: string | undefined;
  /** Offset (in bytes) related to the error, if available. */
  readonly offset?: bigint | undefined;
  /** Underlying cause, if available. */
  override readonly cause?: unknown;

  /** Create an ArchiveError with a stable code. */
  constructor(
    code: ArchiveErrorCode,
    message: string,
    options?: {
      entryName?: string | undefined;
      offset?: bigint | undefined;
      cause?: unknown;
    }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'ArchiveError';
    this.code = code;
    this.entryName = options?.entryName;
    this.offset = options?.offset;
    this.cause = options?.cause;
  }
}
