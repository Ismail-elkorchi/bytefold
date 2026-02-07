import { HttpError } from '../http/errors.js';
import { mergeSignals, throwIfAborted } from '../abort.js';

export interface RandomAccess {
  size(signal?: AbortSignal): Promise<bigint>;
  read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}

export class BufferRandomAccess implements RandomAccess {
  constructor(private readonly data: Uint8Array) {}

  async size(signal?: AbortSignal): Promise<bigint> {
    throwIfAborted(signal);
    return BigInt(this.data.length);
  }

  async read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);
    const start = Number(offset);
    const end = Math.min(this.data.length, start + length);
    return this.data.subarray(start, end);
  }

  async close(): Promise<void> {
    return;
  }
}

export class BlobRandomAccess implements RandomAccess {
  constructor(private readonly blob: Blob) {}

  async size(signal?: AbortSignal): Promise<bigint> {
    throwIfAborted(signal);
    return BigInt(this.blob.size);
  }

  async read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);
    if (length <= 0) return new Uint8Array(0);
    const size = BigInt(this.blob.size);
    if (offset >= size) return new Uint8Array(0);
    const end = minBigInt(offset + BigInt(length), size);
    const startNumber = Number(offset);
    const endNumber = Number(end);
    if (!Number.isSafeInteger(startNumber) || !Number.isSafeInteger(endNumber)) {
      throw new RangeError('Blob random access offset exceeds safe integer range');
    }
    const chunk = this.blob.slice(startNumber, endNumber);
    const bytes = new Uint8Array(await chunk.arrayBuffer());
    throwIfAborted(signal);
    return bytes;
  }

  async close(): Promise<void> {
    return;
  }
}

export interface HttpRandomAccessOptions {
  headers?: Record<string, string>;
  cache?: {
    blockSize?: number;
    maxBlocks?: number;
  };
  signal?: AbortSignal;
  snapshotPolicy?: 'require-strong-etag' | 'best-effort';
}

export class HttpRandomAccess implements RandomAccess {
  private readonly url: string;
  private readonly headers: Headers;
  private readonly blockSize: number;
  private readonly maxBlocks: number;
  private readonly cache = new Map<bigint, Uint8Array>();
  private resolvedSizeBytes?: bigint;
  private pinnedEtag?: string;
  private pinnedLastModified?: string;
  private readonly signal: AbortSignal | null;
  private readonly snapshotPolicy: 'require-strong-etag' | 'best-effort';
  private readonly shouldSkipRangeAcceptEncoding: boolean;

  constructor(url: string | URL, options?: HttpRandomAccessOptions) {
    this.url = typeof url === 'string' ? url : url.toString();
    const headers = new Headers(options?.headers ?? {});
    headers.delete('accept-encoding');
    this.headers = headers;
    const blockSize = options?.cache?.blockSize ?? 64 * 1024;
    const maxBlocks = options?.cache?.maxBlocks ?? 64;
    this.blockSize = Number.isFinite(blockSize) && blockSize > 0 ? Math.floor(blockSize) : 64 * 1024;
    this.maxBlocks = Number.isFinite(maxBlocks) && maxBlocks > 0 ? Math.floor(maxBlocks) : 64;
    this.signal = options?.signal ?? null;
    this.snapshotPolicy = options?.snapshotPolicy ?? 'best-effort';
    this.shouldSkipRangeAcceptEncoding = isNodeRuntime();
  }

  async size(signal?: AbortSignal): Promise<bigint> {
    if (this.resolvedSizeBytes !== undefined) return this.resolvedSizeBytes;

    const headSize = await this.tryHeadSize(signal);
    if (headSize !== undefined) {
      this.resolvedSizeBytes = headSize;
      return headSize;
    }

    const rangeSize = await this.probeSizeWithRangeRequest(signal);
    this.resolvedSizeBytes = rangeSize;
    return rangeSize;
  }

  async read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);
    if (length <= 0) return new Uint8Array(0);
    const size = await this.size(signal);
    if (offset >= size) return new Uint8Array(0);
    const available = size - offset;
    const lengthToRead = available < BigInt(length) ? Number(available) : length;
    if (lengthToRead <= 0) return new Uint8Array(0);

    const blockSize = BigInt(this.blockSize);
    const startBlock = offset / blockSize;
    const endBlock = (offset + BigInt(lengthToRead) - 1n) / blockSize;

    const requestedBytes = new Uint8Array(lengthToRead);

    for (let blockIndex = startBlock; blockIndex <= endBlock; blockIndex += 1n) {
      throwIfAborted(signal);
      const blockStart = blockIndex * blockSize;
      const blockEnd = minBigInt(blockStart + blockSize - 1n, size - 1n);
      const block = await this.getBlock(blockIndex, blockStart, blockEnd, signal);

      const copyStart = offset > blockStart ? offset - blockStart : 0n;
      const copyEnd = minBigInt(blockStart + BigInt(block.length), offset + BigInt(lengthToRead)) - blockStart;
      const copyLength = Number(copyEnd - copyStart);
      if (copyLength <= 0) continue;
      const destOffset = Number(blockStart + copyStart - offset);
      requestedBytes.set(block.subarray(Number(copyStart), Number(copyStart) + copyLength), destOffset);
    }

    return requestedBytes;
  }

  async close(): Promise<void> {
    this.cache.clear();
  }

  private async tryHeadSize(signal?: AbortSignal): Promise<bigint | undefined> {
    try {
      const merged = mergeSignals(this.signal, signal);
      const headers = new Headers(this.headers);
      applyAcceptEncoding(headers);
      const response = await fetch(this.url, {
        method: 'HEAD',
        headers,
        signal: merged ?? null
      });
      if (!response.ok) return undefined;
      ensureIdentityEncoding(this.url, response, 'HEAD');
      this.applyValidators(response);
      const lengthHeader = response.headers.get('content-length');
      if (!lengthHeader) return undefined;
      try {
        const parsedLength = BigInt(lengthHeader);
        if (parsedLength < 0n) return undefined;
        return parsedLength;
      } catch {
        return undefined;
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return undefined;
    }
  }

  private async probeSizeWithRangeRequest(signal?: AbortSignal): Promise<bigint> {
    const response = await this.fetchRangeResponse(
      0n,
      0n,
      signal ? { signal, shouldExpectTotalSize: true } : { shouldExpectTotalSize: true }
    );
    return response.size;
  }

  private async getBlock(index: bigint, start: bigint, end: bigint, signal?: AbortSignal): Promise<Uint8Array> {
    const cached = this.cache.get(index);
    if (cached) {
      this.cache.delete(index);
      this.cache.set(index, cached);
      return cached;
    }
    const data = await this.fetchRange(start, end, signal);
    if (this.maxBlocks > 0) {
      this.cache.set(index, data);
      if (this.cache.size > this.maxBlocks) {
        const oldest = this.cache.keys().next().value as bigint | undefined;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }
    return data;
  }

  private async fetchRange(start: bigint, end: bigint, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.fetchRangeResponse(
      start,
      end,
      signal ? { signal, shouldExpectTotalSize: false } : { shouldExpectTotalSize: false }
    );
    return response.data;
  }

  private async fetchRangeResponse(
    start: bigint,
    end: bigint,
    options: { signal?: AbortSignal; shouldExpectTotalSize: boolean }
  ): Promise<{ data: Uint8Array; size: bigint }> {
    const requestController = new AbortController();
    const merged = mergeSignals(this.signal, options.signal, requestController.signal);
    const headers = new Headers(this.headers);
    if (!this.shouldSkipRangeAcceptEncoding) {
      applyAcceptEncoding(headers);
    }
    headers.set('Range', `bytes=${start}-${end}`);
    const ifRange = this.buildIfRangeHeader();
    const didSendIfRange = ifRange !== undefined;
    if (ifRange) {
      headers.set('If-Range', ifRange);
    }
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'GET',
        headers,
        signal: merged ?? null
      });
    } catch (err) {
      if (isLikelyContentEncodingError(err)) {
        throw new HttpError(
          'HTTP_CONTENT_ENCODING',
          'Content-Encoding is not allowed for seekable HTTP range sessions',
          {
            context: { url: this.url, contentEncoding: 'unknown', requestedRange: `${start}-${end}` }
          }
        );
      }
      throw err;
    }

    const rejectFromHeaders = async (
      code: 'HTTP_RANGE_UNSUPPORTED' | 'HTTP_RESOURCE_CHANGED' | 'HTTP_RANGE_INVALID' | 'HTTP_BAD_RESPONSE' | 'HTTP_SIZE_UNKNOWN',
      message: string,
      context?: Record<string, string>
    ): Promise<never> => {
      await abortResponse(response, requestController);
      throw new HttpError(code, message, context ? { context } : undefined);
    };

    if (response.status === 200) {
      const mismatch = this.findValidatorMismatch(response);
      if (didSendIfRange) {
        await rejectFromHeaders('HTTP_RESOURCE_CHANGED', 'Remote resource changed during range session', mismatch ?? {
          expectedEtag: ifRange ?? 'unknown'
        });
      }
      await rejectFromHeaders('HTTP_RANGE_UNSUPPORTED', 'Server does not support HTTP range requests');
    }

    if (response.status === 416) {
      await rejectFromHeaders('HTTP_RANGE_INVALID', 'HTTP range request was rejected by the server', {
        status: String(response.status)
      });
    }

    if (response.status !== 206) {
      await rejectFromHeaders('HTTP_BAD_RESPONSE', `Unexpected HTTP status ${response.status}`);
    }

    try {
      ensureIdentityEncoding(this.url, response, `${start}-${end}`);
      this.applyValidators(response);
    } catch (err) {
      await abortResponse(response, requestController);
      throw err;
    }

    const contentRangeHeader = response.headers.get('content-range');
    if (!contentRangeHeader) {
      await rejectFromHeaders('HTTP_RANGE_INVALID', 'Missing Content-Range header', {
        range: `${start}-${end}`
      });
    }
    const contentRange = contentRangeHeader!;

    const parsedContentRange = parseContentRange(contentRange.trim());
    if (!parsedContentRange) {
      await rejectFromHeaders('HTTP_RANGE_INVALID', 'Malformed Content-Range header', {
        contentRange
      });
    }
    const parsedRange = parsedContentRange!;

    if (parsedRange.start !== start || parsedRange.end !== end) {
      await rejectFromHeaders('HTTP_RANGE_INVALID', 'Content-Range does not match requested range', {
        requested: `${start}-${end}`,
        actual: `${parsedRange.start}-${parsedRange.end}`
      });
    }

    if (parsedRange.size === undefined) {
      if (options.shouldExpectTotalSize) {
        await rejectFromHeaders('HTTP_SIZE_UNKNOWN', 'Unable to determine remote size from Content-Range');
      }
      await rejectFromHeaders('HTTP_RANGE_INVALID', 'Content-Range did not include a total size', {
        contentRange
      });
    }
    const parsedSize = parsedRange.size!;

    if (this.resolvedSizeBytes !== undefined && parsedSize !== this.resolvedSizeBytes) {
      await rejectFromHeaders('HTTP_RESOURCE_CHANGED', 'Remote resource changed during range session', {
        expectedSize: this.resolvedSizeBytes.toString(),
        actualSize: parsedSize.toString()
      });
    }

    const expectedLength = Number(parsedRange.end - parsedRange.start + 1n);
    if (!Number.isFinite(expectedLength) || expectedLength < 0) {
      await rejectFromHeaders('HTTP_RANGE_INVALID', 'Content-Range produced an invalid length', {
        contentRange
      });
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader !== null) {
      if (!/^\d+$/.test(contentLengthHeader.trim())) {
        await rejectFromHeaders('HTTP_BAD_RESPONSE', 'Invalid Content-Length header on HTTP range response', {
          contentLength: contentLengthHeader
        });
      }
      const parsedContentLength = Number(contentLengthHeader);
      if (!Number.isSafeInteger(parsedContentLength) || parsedContentLength < 0) {
        await rejectFromHeaders('HTTP_BAD_RESPONSE', 'Invalid Content-Length header on HTTP range response', {
          contentLength: contentLengthHeader
        });
      }
      if (parsedContentLength !== expectedLength) {
        await rejectFromHeaders('HTTP_BAD_RESPONSE', 'Content-Length does not match requested range', {
          expectedLength: String(expectedLength),
          contentLength: String(parsedContentLength)
        });
      }
    }

    try {
      const data = await readExpectedBodyBytes(
        response,
        expectedLength,
        requestController,
        `${start}-${end}`,
        contentRange
      );
      return { data, size: parsedSize };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      await abortResponse(response, requestController).catch(() => {});
      if (isLikelyContentEncodingError(err)) {
        throw new HttpError(
          'HTTP_CONTENT_ENCODING',
          'Content-Encoding is not allowed for seekable HTTP range sessions',
          {
            context: { url: this.url, contentEncoding: 'unknown', requestedRange: `${start}-${end}` }
          }
        );
      }
      throw new HttpError('HTTP_BAD_RESPONSE', 'Failed to read HTTP range response body', {
        context: { requestedRange: `${start}-${end}` },
        ...(err instanceof Error ? { cause: err } : {})
      });
    }
  }

  private buildIfRangeHeader(): string | undefined {
    if (this.pinnedEtag && isStrongEtag(this.pinnedEtag)) {
      return this.pinnedEtag;
    }
    return undefined;
  }

  private applyValidators(response: Response): void {
    const mismatch = this.findValidatorMismatch(response);
    if (mismatch) {
      throw new HttpError('HTTP_RESOURCE_CHANGED', 'Remote resource changed during range session', {
        context: mismatch
      });
    }
    const etag = response.headers.get('etag');
    if (etag && !this.pinnedEtag) {
      this.pinnedEtag = etag;
    }
    const lastModified = response.headers.get('last-modified');
    if (lastModified && !this.pinnedLastModified) {
      this.pinnedLastModified = lastModified;
    }
    this.enforceStrongEtag(response);
  }

  private findValidatorMismatch(response: Response): Record<string, string> | null {
    const context: Record<string, string> = {};
    const etag = response.headers.get('etag');
    if (etag && this.pinnedEtag && etag !== this.pinnedEtag) {
      context.expectedEtag = this.pinnedEtag;
      context.actualEtag = etag;
    }
    const lastModified = response.headers.get('last-modified');
    if (lastModified && this.pinnedLastModified && lastModified !== this.pinnedLastModified) {
      context.expectedLastModified = this.pinnedLastModified;
      context.actualLastModified = lastModified;
    }
    return Object.keys(context).length > 0 ? context : null;
  }

  private enforceStrongEtag(response: Response): void {
    if (this.snapshotPolicy !== 'require-strong-etag') return;
    const etag = response.headers.get('etag');
    const hasStrongPinnedEtag = this.pinnedEtag ? isStrongEtag(this.pinnedEtag) : false;
    const hasStrongCurrentEtag = etag ? isStrongEtag(etag) : false;
    if (hasStrongPinnedEtag || hasStrongCurrentEtag) return;
    throw new HttpError('HTTP_STRONG_ETAG_REQUIRED', 'Strong ETag required for HTTP snapshot consistency', {
      context: { url: this.url }
    });
  }
}

type ParsedContentRange = {
  start: bigint;
  end: bigint;
  size?: bigint;
};

async function readExpectedBodyBytes(
  response: Response,
  expectedLength: number,
  requestController: AbortController,
  requestedRange: string,
  contentRange: string
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    await abortResponse(response, requestController);
    throw new HttpError('HTTP_BAD_RESPONSE', 'HTTP range response body was missing', {
      context: { requestedRange, contentRange }
    });
  }
  const reader = body.getReader();
  const responseBytes = new Uint8Array(expectedLength);
  let offset = 0;
  try {
    while (offset < expectedLength) {
      const { done, value } = await reader.read();
      if (done) {
        await abortResponse(response, requestController);
        throw new HttpError('HTTP_BAD_RESPONSE', 'HTTP range response body was shorter than expected', {
          context: {
            requestedRange,
            contentRange,
            expectedLength: String(expectedLength),
            actualLength: String(offset)
          }
        });
      }
      if (!value || value.length === 0) continue;
      const remaining = expectedLength - offset;
      if (value.length > remaining) {
        await abortResponse(response, requestController);
        throw new HttpError('HTTP_BAD_RESPONSE', 'HTTP range response body was longer than expected', {
          context: {
            requestedRange,
            contentRange,
            expectedLength: String(expectedLength),
            actualLength: String(offset + value.length)
          }
        });
      }
      responseBytes.set(value, offset);
      offset += value.length;
    }
    const trailingRead = await reader.read();
    if (!trailingRead.done && trailingRead.value && trailingRead.value.length > 0) {
      await abortResponse(response, requestController);
      throw new HttpError('HTTP_BAD_RESPONSE', 'HTTP range response body was longer than expected', {
        context: {
          requestedRange,
          contentRange,
          expectedLength: String(expectedLength),
          actualLength: String(expectedLength + trailingRead.value.length)
        }
      });
    }
    return responseBytes;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (isLikelyContentEncodingError(err)) {
      throw new HttpError('HTTP_CONTENT_ENCODING', 'Content-Encoding is not allowed for seekable HTTP range sessions', {
        context: { url: response.url, contentEncoding: 'unknown', requestedRange }
      });
    }
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore release errors
    }
  }
}

async function abortResponse(response: Response, requestController: AbortController): Promise<void> {
  try {
    requestController.abort(new DOMException('HTTP range response rejected', 'AbortError'));
  } catch {
    // ignore abort errors
  }
  await cancelResponseBody(response);
}

function parseContentRange(header: string): ParsedContentRange | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header);
  if (!match) return null;
  const start = BigInt(match[1]!);
  const end = BigInt(match[2]!);
  if (end < start) return null;
  const sizeText = match[3]!;
  let size: bigint | undefined;
  if (sizeText !== '*') {
    size = BigInt(sizeText);
    if (size <= end) return null;
  }
  if (size === undefined) {
    return { start, end };
  }
  return { start, end, size };
}

function applyAcceptEncoding(headers: Headers): void {
  headers.delete('accept-encoding');
  headers.set('Accept-Encoding', 'identity');
}

function ensureIdentityEncoding(url: string, response: Response, requestedRange: string): void {
  const encoding = response.headers.get('content-encoding');
  if (!encoding) return;
  const normalized = encoding.trim().toLowerCase();
  if (normalized === '' || normalized === 'identity') return;
  throw new HttpError('HTTP_CONTENT_ENCODING', 'Content-Encoding is not allowed for seekable HTTP range sessions', {
    context: { url, contentEncoding: encoding, requestedRange }
  });
}

function isStrongEtag(etag: string): boolean {
  const trimmed = etag.trimStart();
  if (trimmed === '*') return false;
  return !/^w\//i.test(trimmed);
}

function isLikelyContentEncodingError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const message = (err as { message?: string }).message;
  if (typeof message !== 'string') return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('gzip') ||
    lower.includes('zlib') ||
    (lower.includes('content') && lower.includes('encoding')) ||
    lower.includes('decompress')
  );
}

function isNodeRuntime(): boolean {
  const proc = typeof process !== 'undefined' ? (process as { versions?: { node?: string } }) : undefined;
  const hasNode = !!proc?.versions?.node;
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
  const isDeno = typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined';
  return hasNode && !isBun && !isDeno;
}

async function cancelResponseBody(response: Response): Promise<void> {
  const body = response.body;
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // ignore cancellation errors
  }
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
