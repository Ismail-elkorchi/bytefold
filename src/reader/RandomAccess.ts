import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ZipError } from '../errors.js';
import { mergeSignals, throwIfAborted } from '../abort.js';

export interface RandomAccess {
  size(signal?: AbortSignal): Promise<bigint>;
  read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}

export class FileRandomAccess implements RandomAccess {
  private readonly handlePromise: ReturnType<typeof open>;

  constructor(private readonly path: string) {
    this.handlePromise = open(this.path, 'r');
  }

  async size(signal?: AbortSignal): Promise<bigint> {
    throwIfAborted(signal);
    const handle = await this.handlePromise;
    const stat = await handle.stat();
    throwIfAborted(signal);
    return BigInt(stat.size);
  }

  async read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);
    const handle = await this.handlePromise;
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Number(offset));
    throwIfAborted(signal);
    if (bytesRead === length) return buffer;
    return buffer.subarray(0, bytesRead);
  }

  async close(): Promise<void> {
    const handle = await this.handlePromise;
    await handle.close();
  }

  static fromPath(path: string | URL): FileRandomAccess {
    const filePath = typeof path === 'string' ? path : fileURLToPath(path);
    return new FileRandomAccess(filePath);
  }
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

export interface HttpRandomAccessOptions {
  headers?: Record<string, string>;
  cache?: {
    blockSize?: number;
    maxBlocks?: number;
  };
  signal?: AbortSignal;
}

export class HttpRandomAccess implements RandomAccess {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly blockSize: number;
  private readonly maxBlocks: number;
  private readonly cache = new Map<bigint, Uint8Array>();
  private sizeValue?: bigint;
  private readonly signal: AbortSignal | null;

  constructor(url: string | URL, options?: HttpRandomAccessOptions) {
    this.url = typeof url === 'string' ? url : url.toString();
    this.headers = options?.headers ?? {};
    const blockSize = options?.cache?.blockSize ?? 64 * 1024;
    const maxBlocks = options?.cache?.maxBlocks ?? 64;
    this.blockSize = Number.isFinite(blockSize) && blockSize > 0 ? Math.floor(blockSize) : 64 * 1024;
    this.maxBlocks = Number.isFinite(maxBlocks) && maxBlocks > 0 ? Math.floor(maxBlocks) : 64;
    this.signal = options?.signal ?? null;
  }

  async size(signal?: AbortSignal): Promise<bigint> {
    if (this.sizeValue !== undefined) return this.sizeValue;

    const headSize = await this.tryHeadSize(signal);
    if (headSize !== undefined) {
      this.sizeValue = headSize;
      return headSize;
    }

    const rangeSize = await this.fetchSizeFromRange(signal);
    this.sizeValue = rangeSize;
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

    const output = new Uint8Array(lengthToRead);

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
      output.set(block.subarray(Number(copyStart), Number(copyStart) + copyLength), destOffset);
    }

    return output;
  }

  async close(): Promise<void> {
    this.cache.clear();
  }

  private async tryHeadSize(signal?: AbortSignal): Promise<bigint | undefined> {
    try {
      const merged = mergeSignals(this.signal, signal);
      const response = await fetch(this.url, {
        method: 'HEAD',
        headers: this.headers,
        signal: merged ?? null
      });
      if (!response.ok) return undefined;
      const lengthHeader = response.headers.get('content-length');
      if (!lengthHeader) return undefined;
      try {
        const parsed = BigInt(lengthHeader);
        if (parsed < 0n) return undefined;
        return parsed;
      } catch {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }

  private async fetchSizeFromRange(signal?: AbortSignal): Promise<bigint> {
    const merged = mergeSignals(this.signal, signal);
    const headers = { ...this.headers, Range: 'bytes=0-0' };
    const response = await fetch(this.url, {
      method: 'GET',
      headers,
      signal: merged ?? null
    });
    if (response.status === 200) {
      throw new ZipError('ZIP_HTTP_RANGE_UNSUPPORTED', 'Server does not support HTTP range requests');
    }
    if (response.status !== 206) {
      throw new ZipError('ZIP_HTTP_BAD_RESPONSE', `Unexpected HTTP status ${response.status}`);
    }
    const contentRange = response.headers.get('content-range');
    if (!contentRange) {
      throw new ZipError('ZIP_HTTP_SIZE_UNKNOWN', 'Missing Content-Range header');
    }
    const match = /^bytes\s+\d+-\d+\/(\d+|\*)$/i.exec(contentRange.trim());
    const sizeText = match?.[1];
    if (!sizeText || sizeText === '*') {
      throw new ZipError('ZIP_HTTP_SIZE_UNKNOWN', 'Unable to determine remote size from Content-Range');
    }
    return BigInt(sizeText);
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
    const merged = mergeSignals(this.signal, signal);
    const headers = { ...this.headers, Range: `bytes=${start}-${end}` };
    const response = await fetch(this.url, {
      method: 'GET',
      headers,
      signal: merged ?? null
    });
    if (response.status === 200) {
      throw new ZipError('ZIP_HTTP_RANGE_UNSUPPORTED', 'Server does not support HTTP range requests');
    }
    if (response.status !== 206) {
      throw new ZipError('ZIP_HTTP_BAD_RESPONSE', `Unexpected HTTP status ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
