import { mkdir, symlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipError } from '../errors.js';
import type { ZipEntry, ZipExtractOptions, ZipLimits, ZipReaderOpenOptions, ZipReaderOptions, ZipWarning } from '../types.js';
import { BufferRandomAccess, FileRandomAccess, HttpRandomAccess } from './RandomAccess.js';
import type { RandomAccess } from './RandomAccess.js';
import { findEocd } from './eocd.js';
import { readCentralDirectory, ZipEntryRecord } from './centralDirectory.js';
import { openEntryStream, openRawStream } from './entryStream.js';

const DEFAULT_LIMITS: Required<ZipLimits> = {
  maxEntries: 10000,
  maxUncompressedEntryBytes: 512n * 1024n * 1024n,
  maxTotalUncompressedBytes: 2n * 1024n * 1024n * 1024n,
  maxCompressionRatio: 1000
};

export class ZipReader {
  private readonly strict: boolean;
  private readonly limits: Required<ZipLimits>;
  private readonly warningsList: ZipWarning[] = [];
  private entriesList: ZipEntryRecord[] = [];

  private constructor(
    private readonly reader: RandomAccess,
    options?: ZipReaderOptions
  ) {
    this.strict = options?.strict ?? true;
    this.limits = normalizeLimits(options?.limits);
  }

  static async fromFile(pathLike: string | URL, options?: ZipReaderOptions): Promise<ZipReader> {
    const reader = FileRandomAccess.fromPath(pathLike);
    const instance = new ZipReader(reader, options);
    await instance.init();
    return instance;
  }

  static async fromUint8Array(data: Uint8Array, options?: ZipReaderOptions): Promise<ZipReader> {
    const reader = new BufferRandomAccess(data);
    const instance = new ZipReader(reader, options);
    await instance.init();
    return instance;
  }

  static async fromUrl(
    url: string | URL,
    options?: ZipReaderOptions & {
      http?: {
        headers?: Record<string, string>;
        cache?: { blockSize?: number; maxBlocks?: number };
        signal?: AbortSignal;
      };
    }
  ): Promise<ZipReader> {
    const reader = new HttpRandomAccess(url, options?.http);
    const instance = new ZipReader(reader, options);
    await instance.init();
    return instance;
  }

  entries(): ZipEntry[] {
    return this.entriesList.map((entry) => ({ ...entry }));
  }

  warnings(): ZipWarning[] {
    return [...this.warningsList];
  }

  async open(entry: ZipEntry, options?: ZipReaderOpenOptions): Promise<ReadableStream<Uint8Array>> {
    const strict = options?.strict ?? this.strict;
    return openEntryStream(this.reader, entry as ZipEntryRecord, {
      strict,
      onWarning: (warning) => this.warningsList.push(warning)
    });
  }

  async openRaw(entry: ZipEntry): Promise<ReadableStream<Uint8Array>> {
    const { stream } = await openRawStream(this.reader, entry as ZipEntryRecord);
    return stream;
  }

  async extractAll(destDir: string | URL, options?: ZipExtractOptions): Promise<void> {
    const baseDir = typeof destDir === 'string' ? destDir : fileURLToPath(destDir);
    const strict = options?.strict ?? this.strict;
    const allowSymlinks = options?.allowSymlinks ?? false;
    const limits = normalizeLimits(options?.limits ?? this.limits);

    let totalUncompressed = 0n;
    await mkdir(baseDir, { recursive: true });

    for (const entry of this.entriesList) {
      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > limits.maxTotalUncompressedBytes) {
        throw new ZipError('ZIP_LIMIT_EXCEEDED', 'Total uncompressed size exceeds limit');
      }

      const targetPath = resolveEntryPath(baseDir, entry.name);
      if (entry.isDirectory) {
        await mkdir(targetPath, { recursive: true });
        continue;
      }

      if (entry.isSymlink) {
        if (!allowSymlinks) {
          throw new ZipError('ZIP_SYMLINK_DISALLOWED', 'Symlink entries are disabled by default', {
            entryName: entry.name
          });
        }
        await mkdir(path.dirname(targetPath), { recursive: true });
        const stream = await openEntryStream(this.reader, entry, {
          strict,
          onWarning: (warning) => this.warningsList.push(warning)
        });
        const buf = await new Response(stream).arrayBuffer();
        const target = new TextDecoder('utf-8').decode(buf);
        await symlink(target, targetPath);
        continue;
      }

      await mkdir(path.dirname(targetPath), { recursive: true });
      const stream = await openEntryStream(this.reader, entry, {
        strict,
        onWarning: (warning) => this.warningsList.push(warning)
      });
      const nodeReadable = Readable.fromWeb(stream as any);
      await pipeline(nodeReadable, createWriteStream(targetPath));
    }
  }

  async close(): Promise<void> {
    await this.reader.close();
  }

  private async init(): Promise<void> {
    const eocd = await findEocd(this.reader, this.strict);
    this.warningsList.push(...eocd.warnings);

    const cd = await readCentralDirectory(this.reader, eocd.cdOffset, eocd.cdSize, eocd.totalEntries, {
      strict: this.strict,
      maxEntries: this.limits.maxEntries
    });
    this.warningsList.push(...cd.warnings);

    this.entriesList = cd.entries;

    let totalUncompressed = 0n;
    for (const entry of this.entriesList) {
      if (entry.uncompressedSize > this.limits.maxUncompressedEntryBytes) {
        throw new ZipError('ZIP_LIMIT_EXCEEDED', 'Entry exceeds max uncompressed size', {
          entryName: entry.name
        });
      }
      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > this.limits.maxTotalUncompressedBytes) {
        throw new ZipError('ZIP_LIMIT_EXCEEDED', 'Total uncompressed size exceeds limit');
      }
      if (entry.compressedSize > 0n) {
        const ratio = Number(entry.uncompressedSize) / Number(entry.compressedSize);
        if (ratio > this.limits.maxCompressionRatio) {
          const message = 'Compression ratio exceeds safety limit';
          if (this.strict) {
            throw new ZipError('ZIP_LIMIT_EXCEEDED', message, { entryName: entry.name });
          }
          this.warningsList.push({ code: 'ZIP_LIMIT_EXCEEDED', message, entryName: entry.name });
        }
      }
    }
  }
}

function normalizeLimits(limits?: ZipLimits): Required<ZipLimits> {
  return {
    maxEntries: limits?.maxEntries ?? DEFAULT_LIMITS.maxEntries,
    maxUncompressedEntryBytes: toBigInt(limits?.maxUncompressedEntryBytes) ?? DEFAULT_LIMITS.maxUncompressedEntryBytes,
    maxTotalUncompressedBytes: toBigInt(limits?.maxTotalUncompressedBytes) ?? DEFAULT_LIMITS.maxTotalUncompressedBytes,
    maxCompressionRatio: limits?.maxCompressionRatio ?? DEFAULT_LIMITS.maxCompressionRatio
  };
}

function toBigInt(value?: bigint | number): bigint | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'bigint' ? value : BigInt(value);
}

function resolveEntryPath(baseDir: string, entryName: string): string {
  if (entryName.includes('\u0000')) {
    throw new ZipError('ZIP_PATH_TRAVERSAL', 'Entry name contains NUL byte', { entryName });
  }
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new ZipError('ZIP_PATH_TRAVERSAL', 'Absolute paths are not allowed in ZIP entries', {
      entryName
    });
  }
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.some((part) => part === '..')) {
    throw new ZipError('ZIP_PATH_TRAVERSAL', 'Path traversal detected in ZIP entry', { entryName });
  }
  const resolved = path.resolve(baseDir, ...parts);
  const baseResolved = path.resolve(baseDir);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
    throw new ZipError('ZIP_PATH_TRAVERSAL', 'Entry path escapes destination directory', { entryName });
  }
  return resolved;
}
