export type CompressionErrorCode =
  | 'COMPRESSION_UNSUPPORTED_ALGORITHM'
  | 'COMPRESSION_BACKEND_UNAVAILABLE';

export class CompressionError extends Error {
  readonly code: CompressionErrorCode;
  readonly algorithm?: string;
  readonly cause?: unknown;

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
