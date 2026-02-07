import { HttpError, type HttpErrorCode } from '../http/errors.js';
import { ArchiveError, type ArchiveErrorCode } from './errors.js';

const HTTP_TO_ARCHIVE: Record<HttpErrorCode, ArchiveErrorCode> = {
  HTTP_RANGE_UNSUPPORTED: 'ARCHIVE_HTTP_RANGE_UNSUPPORTED',
  HTTP_RANGE_INVALID: 'ARCHIVE_HTTP_RANGE_INVALID',
  HTTP_RESOURCE_CHANGED: 'ARCHIVE_HTTP_RESOURCE_CHANGED',
  HTTP_CONTENT_ENCODING: 'ARCHIVE_HTTP_CONTENT_ENCODING',
  HTTP_STRONG_ETAG_REQUIRED: 'ARCHIVE_HTTP_STRONG_ETAG_REQUIRED',
  HTTP_BAD_RESPONSE: 'ARCHIVE_HTTP_BAD_RESPONSE',
  HTTP_SIZE_UNKNOWN: 'ARCHIVE_HTTP_SIZE_UNKNOWN'
};

export function mapHttpErrorToArchiveError(err: unknown, context?: Record<string, string>): unknown {
  if (!(err instanceof HttpError)) return err;
  const code = HTTP_TO_ARCHIVE[err.code] ?? 'ARCHIVE_HTTP_BAD_RESPONSE';
  return new ArchiveError(code, err.message, {
    context: {
      ...(context ?? {}),
      ...(err.context ?? {}),
      httpCode: err.code
    },
    cause: err
  });
}

