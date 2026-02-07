import { sanitizeErrorContext } from './errorContext.js';
import { BYTEFOLD_REPORT_SCHEMA_VERSION } from './reportSchema.js';

/** Stable ZIP error codes. */
export type ZipErrorCode =
  | 'ZIP_HTTP_RANGE_UNSUPPORTED'
  | 'ZIP_HTTP_RESOURCE_CHANGED'
  | 'ZIP_HTTP_RANGE_INVALID'
  | 'ZIP_HTTP_BAD_RESPONSE'
  | 'ZIP_HTTP_SIZE_UNKNOWN'
  | 'ZIP_HTTP_CONTENT_ENCODING'
  | 'ZIP_HTTP_STRONG_ETAG_REQUIRED'
  | 'ZIP_EOCD_NOT_FOUND'
  | 'ZIP_MULTIPLE_EOCD'
  | 'ZIP_BAD_EOCD'
  | 'ZIP_BAD_ZIP64'
  | 'ZIP_BAD_CENTRAL_DIRECTORY'
  | 'ZIP_NAME_COLLISION'
  | 'ZIP_UNSUPPORTED_METHOD'
  | 'ZIP_UNSUPPORTED_FEATURE'
  | 'ZIP_UNSUPPORTED_ENCRYPTION'
  | 'ZIP_ZSTD_UNAVAILABLE'
  | 'ZIP_DEFLATE64_BAD_DATA'
  | 'ZIP_BAD_CRC'
  | 'ZIP_BAD_PASSWORD'
  | 'ZIP_PASSWORD_REQUIRED'
  | 'ZIP_AUTH_FAILED'
  | 'ZIP_SINK_NOT_SEEKABLE'
  | 'ZIP_ZIP64_REQUIRED'
  | 'ZIP_PATH_TRAVERSAL'
  | 'ZIP_SYMLINK_DISALLOWED'
  | 'ZIP_LIMIT_EXCEEDED'
  | 'ZIP_INVALID_ENCODING'
  | 'ZIP_TRUNCATED'
  | 'ZIP_INVALID_SIGNATURE'
  | 'ZIP_ENTRIES_NOT_STORED'
  | 'ZIP_AUDIT_FAILED';

/** Error thrown for ZIP parsing, validation, and write failures. */
export class ZipError extends Error {
  /** Machine-readable error code. */
  readonly code: ZipErrorCode;
  /** Entry name related to the error, if available. */
  readonly entryName?: string | undefined;
  /** Compression method related to the error, if available. */
  readonly method?: number | undefined;
  /** Offset (in bytes) related to the error, if available. */
  readonly offset?: bigint | undefined;
  /** Underlying cause, if available. */
  override readonly cause?: unknown;
  /** Additional context for serialization. */
  readonly context?: Record<string, string> | undefined;

  /** Create a ZipError with a stable code. */
  constructor(
    code: ZipErrorCode,
    message: string,
    options?: {
      entryName?: string | undefined;
      method?: number | undefined;
      offset?: bigint | undefined;
      context?: Record<string, string> | undefined;
      cause?: unknown;
    }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'ZipError';
    this.code = code;
    this.entryName = options?.entryName;
    this.method = options?.method;
    this.offset = options?.offset;
    this.context = options?.context;
    this.cause = options?.cause;
  }

  /** JSON-safe serialization with schemaVersion "1". */
  toJSON(): {
    schemaVersion: string;
    name: string;
    code: ZipErrorCode;
    message: string;
    hint: string;
    context: Record<string, string>;
    entryName?: string;
    method?: number;
    offset?: string;
  } {
    const topLevelShadowKeys: string[] = [];
    if (this.entryName !== undefined) topLevelShadowKeys.push('entryName');
    if (this.method !== undefined) topLevelShadowKeys.push('method');
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
      ...(this.method !== undefined ? { method: this.method } : {}),
      ...(this.offset !== undefined ? { offset: this.offset.toString() } : {})
    };
  }
}

/** Non-fatal ZIP warning codes. */
export type ZipWarningCode =
  | 'ZIP_MULTIPLE_EOCD'
  | 'ZIP_BAD_EOCD'
  | 'ZIP_BAD_CENTRAL_DIRECTORY'
  | 'ZIP_BAD_CRC'
  | 'ZIP_INVALID_ENCODING'
  | 'ZIP_LIMIT_EXCEEDED'
  | 'ZIP_UNSUPPORTED_FEATURE';

/** Non-fatal warning produced while parsing ZIP structures. */
export type ZipWarning = {
  code: ZipWarningCode;
  message: string;
  entryName?: string;
};
