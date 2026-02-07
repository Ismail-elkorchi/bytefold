import { sanitizeErrorContext } from '../errorContext.js';
import { BYTEFOLD_REPORT_SCHEMA_VERSION } from '../reportSchema.js';

/** Stable archive error codes. */
export type ArchiveErrorCode =
  | 'ARCHIVE_UNSUPPORTED_FORMAT'
  | 'ARCHIVE_TRUNCATED'
  | 'ARCHIVE_BAD_HEADER'
  | 'ARCHIVE_NAME_COLLISION'
  | 'ARCHIVE_PATH_TRAVERSAL'
  | 'ARCHIVE_LIMIT_EXCEEDED'
  | 'ARCHIVE_UNSUPPORTED_FEATURE'
  | 'ARCHIVE_HTTP_RANGE_UNSUPPORTED'
  | 'ARCHIVE_HTTP_RANGE_INVALID'
  | 'ARCHIVE_HTTP_RESOURCE_CHANGED'
  | 'ARCHIVE_HTTP_CONTENT_ENCODING'
  | 'ARCHIVE_HTTP_STRONG_ETAG_REQUIRED'
  | 'ARCHIVE_HTTP_BAD_RESPONSE'
  | 'ARCHIVE_HTTP_SIZE_UNKNOWN'
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
  /** Additional context for serialization. */
  readonly context?: Record<string, string> | undefined;

  /** Create an ArchiveError with a stable code. */
  constructor(
    code: ArchiveErrorCode,
    message: string,
    options?: {
      entryName?: string | undefined;
      offset?: bigint | undefined;
      context?: Record<string, string> | undefined;
      cause?: unknown;
    }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'ArchiveError';
    this.code = code;
    this.entryName = options?.entryName;
    this.offset = options?.offset;
    this.context = options?.context;
    this.cause = options?.cause;
  }

  /** JSON-safe serialization with schemaVersion "1". */
  toJSON(): {
    schemaVersion: string;
    name: string;
    code: ArchiveErrorCode;
    message: string;
    hint: string;
    context: Record<string, string>;
    entryName?: string;
    offset?: string;
  } {
    const topLevelShadowKeys: string[] = [];
    if (this.entryName !== undefined) topLevelShadowKeys.push('entryName');
    if (this.offset !== undefined) topLevelShadowKeys.push('offset');
    const context = sanitizeErrorContext(this.context, topLevelShadowKeys);
    return {
      schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
      name: this.name,
      code: this.code,
      message: this.message,
      hint: this.message,
      context,
      ...(this.entryName !== undefined ? { entryName: this.entryName } : {}),
      ...(this.offset !== undefined ? { offset: this.offset.toString() } : {})
    };
  }
}
