import { BYTEFOLD_REPORT_SCHEMA_VERSION } from '../reportSchema.js';
import { sanitizeErrorContext } from '../errorContext.js';

/** Stable HTTP range/session error codes. */
export type HttpErrorCode =
  | 'HTTP_RANGE_UNSUPPORTED'
  | 'HTTP_RESOURCE_CHANGED'
  | 'HTTP_RANGE_INVALID'
  | 'HTTP_BAD_RESPONSE'
  | 'HTTP_SIZE_UNKNOWN'
  | 'HTTP_CONTENT_ENCODING'
  | 'HTTP_STRONG_ETAG_REQUIRED';

/** Error thrown for HTTP range session failures. */
export class HttpError extends Error {
  /** Machine-readable error code. */
  readonly code: HttpErrorCode;
  /** Underlying cause, if available. */
  override readonly cause?: unknown;
  /** Additional context for serialization. */
  readonly context?: Record<string, string> | undefined;

  constructor(
    code: HttpErrorCode,
    message: string,
    options?: {
      context?: Record<string, string> | undefined;
      cause?: unknown;
    }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'HttpError';
    this.code = code;
    this.context = options?.context;
    this.cause = options?.cause;
  }

  /** JSON-safe serialization with schemaVersion "1". */
  toJSON(): {
    schemaVersion: string;
    name: string;
    code: HttpErrorCode;
    message: string;
    hint: string;
    context: Record<string, string>;
  } {
    return {
      schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
      name: this.name,
      code: this.code,
      message: this.message,
      hint: this.message,
      context: sanitizeErrorContext(this.context)
    };
  }
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}
