import { sanitizeErrorContext } from '../errorContext.js';
import { BYTEFOLD_REPORT_SCHEMA_VERSION } from '../reportSchema.js';

/** Stable error codes for compression operations. */
export type CompressionErrorCode =
  | 'COMPRESSION_UNSUPPORTED_ALGORITHM'
  | 'COMPRESSION_BACKEND_UNAVAILABLE'
  | 'COMPRESSION_RESOURCE_LIMIT'
  | 'COMPRESSION_GZIP_BAD_HEADER'
  | 'COMPRESSION_BZIP2_BAD_DATA'
  | 'COMPRESSION_BZIP2_CRC_MISMATCH'
  | 'COMPRESSION_XZ_BAD_DATA'
  | 'COMPRESSION_XZ_BAD_CHECK'
  | 'COMPRESSION_XZ_TRUNCATED'
  | 'COMPRESSION_XZ_BUFFER_LIMIT'
  | 'COMPRESSION_XZ_UNSUPPORTED_FILTER'
  | 'COMPRESSION_XZ_UNSUPPORTED_CHECK'
  | 'COMPRESSION_XZ_LIMIT_EXCEEDED'
  | 'COMPRESSION_LZMA_BAD_DATA';

/** Error thrown for compression backend failures or unsupported algorithms. */
export class CompressionError extends Error {
  /** Machine-readable error code. */
  readonly code: CompressionErrorCode;
  /** Algorithm involved in the failure, if available. */
  readonly algorithm?: string;
  /** Underlying cause, if available. */
  override readonly cause?: unknown;
  /** Additional context for serialization. */
  readonly context?: Record<string, string> | undefined;

  /** Create a CompressionError with a stable code. */
  constructor(
    code: CompressionErrorCode,
    message: string,
    options?: { algorithm?: string; context?: Record<string, string> | undefined; cause?: unknown }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'CompressionError';
    this.code = code;
    if (options?.algorithm !== undefined) this.algorithm = options.algorithm;
    if (options?.context !== undefined) this.context = options.context;
    if (options?.cause !== undefined) this.cause = options.cause;
  }

  /** JSON-safe serialization with schemaVersion "1". */
  toJSON(): {
    schemaVersion: string;
    name: string;
    code: CompressionErrorCode;
    message: string;
    hint: string;
    context: Record<string, string>;
    algorithm?: string;
  } {
    const topLevelShadowKeys = this.algorithm !== undefined ? ['algorithm'] : [];
    const context = sanitizeErrorContext(this.context, topLevelShadowKeys);
    return {
      schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
      name: this.name,
      code: this.code,
      message: this.message,
      hint: this.message,
      context,
      ...(this.algorithm !== undefined ? { algorithm: this.algorithm } : {})
    };
  }
}
