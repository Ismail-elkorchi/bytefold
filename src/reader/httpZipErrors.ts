import { HttpError, type HttpErrorCode } from '../http/errors.js';
import { ZipError, type ZipErrorCode } from '../errors.js';
import type { RandomAccess } from './RandomAccess.js';

const HTTP_TO_ZIP: Record<HttpErrorCode, ZipErrorCode> = {
  HTTP_RANGE_UNSUPPORTED: 'ZIP_HTTP_RANGE_UNSUPPORTED',
  HTTP_RESOURCE_CHANGED: 'ZIP_HTTP_RESOURCE_CHANGED',
  HTTP_RANGE_INVALID: 'ZIP_HTTP_RANGE_INVALID',
  HTTP_BAD_RESPONSE: 'ZIP_HTTP_BAD_RESPONSE',
  HTTP_SIZE_UNKNOWN: 'ZIP_HTTP_SIZE_UNKNOWN',
  HTTP_CONTENT_ENCODING: 'ZIP_HTTP_CONTENT_ENCODING',
  HTTP_STRONG_ETAG_REQUIRED: 'ZIP_HTTP_STRONG_ETAG_REQUIRED'
};

export function mapHttpErrorToZipError(err: unknown): unknown {
  if (!(err instanceof HttpError)) return err;
  const mapped = HTTP_TO_ZIP[err.code] ?? 'ZIP_HTTP_BAD_RESPONSE';
  return new ZipError(mapped, err.message, { context: err.context, cause: err.cause });
}

class ZipHttpRandomAccess implements RandomAccess {
  constructor(private readonly inner: RandomAccess) {}

  async size(signal?: AbortSignal): Promise<bigint> {
    try {
      return await this.inner.size(signal);
    } catch (err) {
      throw mapHttpErrorToZipError(err);
    }
  }

  async read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    try {
      return await this.inner.read(offset, length, signal);
    } catch (err) {
      throw mapHttpErrorToZipError(err);
    }
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

export function wrapRandomAccessForZip(reader: RandomAccess): RandomAccess {
  if (reader instanceof ZipHttpRandomAccess) return reader;
  return new ZipHttpRandomAccess(reader);
}
