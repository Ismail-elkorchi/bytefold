/** Stable error codes for compression operations. */
export type CompressionErrorCode =
  | 'COMPRESSION_UNSUPPORTED_ALGORITHM'
  | 'COMPRESSION_BACKEND_UNAVAILABLE';

/** Error thrown for compression backend failures or unsupported algorithms. */
export class CompressionError extends Error {
  /** Machine-readable error code. */
  readonly code: CompressionErrorCode;
  /** Algorithm involved in the failure, if available. */
  readonly algorithm?: string;
  /** Underlying cause, if available. */
  override readonly cause?: unknown;

  /** Create a CompressionError with a stable code. */
  constructor(
    code: CompressionErrorCode,
    message: string,
    options?: { algorithm?: string; cause?: unknown }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'CompressionError';
    this.code = code;
    if (options?.algorithm !== undefined) this.algorithm = options.algorithm;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}
