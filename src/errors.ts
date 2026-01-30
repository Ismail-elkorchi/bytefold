export type ZipErrorCode =
  | 'ZIP_HTTP_RANGE_UNSUPPORTED'
  | 'ZIP_HTTP_BAD_RESPONSE'
  | 'ZIP_HTTP_SIZE_UNKNOWN'
  | 'ZIP_EOCD_NOT_FOUND'
  | 'ZIP_MULTIPLE_EOCD'
  | 'ZIP_BAD_EOCD'
  | 'ZIP_BAD_ZIP64'
  | 'ZIP_BAD_CENTRAL_DIRECTORY'
  | 'ZIP_UNSUPPORTED_METHOD'
  | 'ZIP_UNSUPPORTED_FEATURE'
  | 'ZIP_ZSTD_UNAVAILABLE'
  | 'ZIP_BAD_CRC'
  | 'ZIP_SINK_NOT_SEEKABLE'
  | 'ZIP_ZIP64_REQUIRED'
  | 'ZIP_PATH_TRAVERSAL'
  | 'ZIP_SYMLINK_DISALLOWED'
  | 'ZIP_LIMIT_EXCEEDED'
  | 'ZIP_INVALID_ENCODING'
  | 'ZIP_TRUNCATED'
  | 'ZIP_INVALID_SIGNATURE';

export class ZipError extends Error {
  readonly code: ZipErrorCode;
  readonly entryName?: string | undefined;
  readonly method?: number | undefined;
  readonly offset?: bigint | undefined;
  readonly cause?: unknown;

  constructor(
    code: ZipErrorCode,
    message: string,
    options?: {
      entryName?: string | undefined;
      method?: number | undefined;
      offset?: bigint | undefined;
      cause?: unknown;
    }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'ZipError';
    this.code = code;
    this.entryName = options?.entryName;
    this.method = options?.method;
    this.offset = options?.offset;
    this.cause = options?.cause;
  }
}

export type ZipWarningCode =
  | 'ZIP_MULTIPLE_EOCD'
  | 'ZIP_BAD_EOCD'
  | 'ZIP_BAD_CENTRAL_DIRECTORY'
  | 'ZIP_BAD_CRC'
  | 'ZIP_INVALID_ENCODING'
  | 'ZIP_LIMIT_EXCEEDED'
  | 'ZIP_UNSUPPORTED_FEATURE';

export interface ZipWarning {
  code: ZipWarningCode;
  message: string;
  entryName?: string;
}
