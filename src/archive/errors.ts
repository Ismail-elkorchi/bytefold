export type ArchiveErrorCode =
  | 'ARCHIVE_UNSUPPORTED_FORMAT'
  | 'ARCHIVE_TRUNCATED'
  | 'ARCHIVE_BAD_HEADER'
  | 'ARCHIVE_PATH_TRAVERSAL'
  | 'ARCHIVE_LIMIT_EXCEEDED'
  | 'ARCHIVE_UNSUPPORTED_FEATURE'
  | 'ARCHIVE_AUDIT_FAILED';

export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;
  readonly entryName?: string | undefined;
  readonly offset?: bigint | undefined;
  readonly cause?: unknown;

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
