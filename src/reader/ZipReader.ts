import { mkdir, symlink, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { ZipError } from '../errors.js';
import { mergeSignals, throwIfAborted } from '../abort.js';
import type {
  ZipAuditOptions,
  ZipAuditReport,
  ZipEntry,
  ZipExtractOptions,
  ZipIssue,
  ZipIssueSeverity,
  ZipLimits,
  ZipNormalizeConflict,
  ZipNormalizeOptions,
  ZipNormalizeReport,
  ZipProfile,
  ZipProgressOptions,
  ZipReaderIterOptions,
  ZipReaderOpenOptions,
  ZipReaderOptions,
  ZipWarning
} from '../types.js';
import { BufferRandomAccess, FileRandomAccess, HttpRandomAccess } from './RandomAccess.js';
import type { RandomAccess } from './RandomAccess.js';
import { findEocd, type EocdResult } from './eocd.js';
import { iterCentralDirectory, type ZipEntryRecord } from './centralDirectory.js';
import { openEntryStream, openRawStream } from './entryStream.js';
import { buildAesExtra, parseAesExtra } from '../extraFields.js';
import { readLocalHeader, type LocalHeaderInfo } from './localHeader.js';
import { isWebWritable, readableFromBytes, toWebReadable } from '../streams/adapters.js';
import { createCrcTransform } from '../streams/crcTransform.js';
import { createMeasureTransform } from '../streams/measure.js';
import { createProgressTracker, createProgressTransform } from '../streams/progress.js';
import { FileSink, NodeWritableSink, WebWritableSink } from '../writer/Sink.js';
import type { Sink } from '../writer/Sink.js';
import { writeCentralDirectory } from '../writer/centralDirectoryWriter.js';
import { finalizeArchive } from '../writer/finalize.js';
import { writeRawEntry, type EntryWriteResult } from '../writer/entryWriter.js';
import { getCompressionCodec, hasCompressionCodec } from '../compression/registry.js';

const DEFAULT_LIMITS: Required<ZipLimits> = {
  maxEntries: 10000,
  maxUncompressedEntryBytes: 512n * 1024n * 1024n,
  maxTotalUncompressedBytes: 2n * 1024n * 1024n * 1024n,
  maxCompressionRatio: 1000
};

const AGENT_LIMITS: Required<ZipLimits> = {
  maxEntries: 5000,
  maxUncompressedEntryBytes: 256n * 1024n * 1024n,
  maxTotalUncompressedBytes: 1024n * 1024n * 1024n,
  maxCompressionRatio: 200
};

export class ZipReader {
  private readonly profile: ZipProfile;
  private readonly strict: boolean;
  private readonly limits: Required<ZipLimits>;
  private readonly warningsList: ZipWarning[] = [];
  private entriesList: ZipEntryRecord[] | null = null;
  private readonly password: string | undefined;
  private readonly storeEntries: boolean;
  private eocd: EocdResult | null = null;
  private readonly signal: AbortSignal | undefined;

  private constructor(
    private readonly reader: RandomAccess,
    options?: ZipReaderOptions
  ) {
    const resolved = resolveReaderProfile(options);
    this.profile = resolved.profile;
    this.strict = resolved.strict;
    this.limits = resolved.limits;
    this.password = options?.password;
    this.storeEntries = options?.storeEntries ?? true;
    this.signal = mergeSignals(options?.signal, options?.http?.signal);
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

  static async fromStream(
    stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
    options?: ZipReaderOptions
  ): Promise<ZipReader> {
    const signal = options?.signal ?? null;
    const tempDir = await mkdtemp(path.join(tmpdir(), 'zip-next-'));
    const tempPath = path.join(tempDir, 'stream.zip');
    const writable = createWriteStream(tempPath);
    const webReadable = toWebReadable(stream);
    const reader = webReadable.getReader();

    try {
      while (true) {
        throwIfAborted(signal);
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        const canWrite = writable.write(value);
        if (!canWrite) {
          const drain = once(writable, 'drain');
          if (signal) {
            await Promise.race([
              drain,
              new Promise<never>((_, reject) => {
                if (signal.aborted) {
                  reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
                  return;
                }
                signal.addEventListener(
                  'abort',
                  () => reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError')),
                  { once: true }
                );
              })
            ]);
          } else {
            await drain;
          }
        }
      }
      await new Promise<void>((resolve, reject) => {
        writable.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      writable.destroy();
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    } finally {
      reader.releaseLock();
    }

    const tempReader = new TempFileRandomAccess(tempPath, tempDir);
    const instance = new ZipReader(tempReader, options);
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
    const httpSignal = mergeSignals(options?.signal, options?.http?.signal);
    const httpOptions: {
      headers?: Record<string, string>;
      cache?: { blockSize?: number; maxBlocks?: number };
      signal?: AbortSignal;
    } = options?.http ? { ...options.http } : {};
    if (httpSignal) {
      httpOptions.signal = httpSignal;
    }
    const reader = new HttpRandomAccess(url, Object.keys(httpOptions).length > 0 ? httpOptions : undefined);
    const instance = new ZipReader(reader, options);
    await instance.init();
    return instance;
  }

  entries(): ZipEntry[] {
    if (!this.storeEntries) {
      throw new ZipError(
        'ZIP_ENTRIES_NOT_STORED',
        'Entries are not stored; use iterEntries() or enable storeEntries'
      );
    }
    if (!this.entriesList) return [];
    return this.entriesList.map((entry) => ({ ...entry }));
  }

  warnings(): ZipWarning[] {
    return [...this.warningsList];
  }

  async *iterEntries(options?: ZipReaderIterOptions): AsyncGenerator<ZipEntry> {
    const signal = this.resolveSignal(options?.signal);
    throwIfAborted(signal);
    if (this.entriesList) {
      for (const entry of this.entriesList) {
        throwIfAborted(signal);
        yield { ...entry };
      }
      return;
    }
    if (!this.eocd) {
      throw new ZipError('ZIP_BAD_CENTRAL_DIRECTORY', 'Central directory has not been initialized');
    }
    const entries: ZipEntryRecord[] = [];
    const totals = { totalUncompressed: 0n };
    for await (const entry of iterCentralDirectory(
      this.reader,
      this.eocd.cdOffset,
      this.eocd.cdSize,
      this.eocd.totalEntries,
      {
        strict: this.strict,
        maxEntries: this.limits.maxEntries,
        onWarning: (warning) => this.warningsList.push(warning),
        ...(signal ? { signal } : {})
      }
    )) {
      throwIfAborted(signal);
      this.applyEntryLimits(entry, totals);
      if (this.storeEntries) entries.push(entry);
      yield { ...entry };
    }
    if (this.storeEntries) {
      this.entriesList = entries;
    }
  }

  async forEachEntry(fn: (entry: ZipEntry) => void | Promise<void>, options?: ZipReaderIterOptions): Promise<void> {
    for await (const entry of this.iterEntries(options)) {
      await fn(entry);
    }
  }

  async open(entry: ZipEntry, options?: ZipReaderOpenOptions): Promise<ReadableStream<Uint8Array>> {
    const strict = options?.strict ?? this.strict;
    const signal = this.resolveSignal(options?.signal);
    const totals = { totalUncompressed: 0n };
    const params: { strict: boolean; onWarning: (warning: ZipWarning) => void; password?: string } = {
      strict,
      onWarning: (warning) => this.warningsList.push(warning)
    };
    const password = options?.password ?? this.password;
    if (password !== undefined) {
      params.password = password;
    }
    return openEntryStream(this.reader, entry as ZipEntryRecord, {
      ...params,
      ...(signal ? { signal } : {}),
      ...progressParams(options),
      limits: this.limits,
      totals
    });
  }

  async openRaw(entry: ZipEntry, options?: ZipReaderOpenOptions): Promise<ReadableStream<Uint8Array>> {
    const signal = this.resolveSignal(options?.signal);
    const { stream } = await openRawStream(this.reader, entry as ZipEntryRecord, {
      ...(signal ? { signal } : {}),
      ...progressParams(options)
    });
    return stream;
  }

  async normalizeToWritable(
    writable: WritableStream<Uint8Array> | NodeJS.WritableStream,
    options?: ZipNormalizeOptions
  ): Promise<ZipNormalizeReport> {
    const sink = isWebWritable(writable) ? new WebWritableSink(writable) : new NodeWritableSink(writable);
    return this.normalizeToSink(sink, options);
  }

  async normalizeToFile(pathLike: string | URL, options?: ZipNormalizeOptions): Promise<ZipNormalizeReport> {
    const sink = new FileSink(pathLike);
    return this.normalizeToSink(sink, options);
  }

  async extractAll(destDir: string | URL, options?: ZipExtractOptions): Promise<void> {
    const baseDir = typeof destDir === 'string' ? destDir : fileURLToPath(destDir);
    const strict = options?.strict ?? this.strict;
    const password = options?.password ?? this.password;
    const allowSymlinks = options?.allowSymlinks ?? false;
    const limits = normalizeLimits(options?.limits ?? this.limits, this.limits);
    const signal = this.resolveSignal(options?.signal);

    let totalUncompressed = 0n;
    const totals = { totalUncompressed: 0n };
    await mkdir(baseDir, { recursive: true });

    const iterOptions = signal ? { signal } : undefined;
    for await (const entry of this.iterEntries(iterOptions)) {
      throwIfAborted(signal);
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
        const stream = await openEntryStream(this.reader, entry as ZipEntryRecord, {
          strict,
          onWarning: (warning) => this.warningsList.push(warning),
          ...(signal ? { signal } : {}),
          ...progressParams(options),
          ...(password !== undefined ? { password } : {}),
          limits,
          totals
        });
        const buf = await new Response(stream).arrayBuffer();
        const target = new TextDecoder('utf-8').decode(buf);
        await symlink(target, targetPath);
        continue;
      }

      await mkdir(path.dirname(targetPath), { recursive: true });
      const stream = await openEntryStream(this.reader, entry as ZipEntryRecord, {
        strict,
        onWarning: (warning) => this.warningsList.push(warning),
        ...(signal ? { signal } : {}),
        ...progressParams(options),
        ...(password !== undefined ? { password } : {}),
        limits,
        totals
      });
      const nodeReadable = Readable.fromWeb(stream as any);
      await pipeline(nodeReadable, createWriteStream(targetPath));
    }
  }

  async audit(options?: ZipAuditOptions): Promise<ZipAuditReport> {
    const settings = this.resolveAuditSettings(options);
    const signal = this.resolveSignal(options?.signal);
    throwIfAborted(signal);
    const issues: ZipIssue[] = [];
    const summary: ZipAuditReport['summary'] = {
      entries: 0,
      encryptedEntries: 0,
      unsupportedEntries: 0,
      warnings: 0,
      errors: 0
    };
    const unsupportedEntries = new Set<string>();
    const ranges: Array<{ start: bigint; end: bigint; entryName: string }> = [];
    const seenNames = new Map<string, number>();
    const seenLower = new Map<string, string>();
    let totalUncompressed = 0n;
    let totalExceeded = false;

    const addIssue = (issue: ZipIssue) => {
      issues.push(issue);
      if (issue.severity === 'warning') summary.warnings += 1;
      if (issue.severity === 'error') summary.errors += 1;
    };

    const addParseWarning = (warning: ZipWarning) => {
      const severity: ZipIssueSeverity = settings.strict ? 'error' : 'warning';
      addIssue({
        code: warning.code,
        severity,
        message: warning.message,
        ...(warning.entryName ? { entryName: warning.entryName } : {})
      });
    };

    let size: bigint;
    try {
      size = await this.reader.size(signal);
    } catch (err) {
      addIssue(issueFromError(err));
      return finalizeAuditReport(issues, summary);
    }

    let eocd: EocdResult;
    try {
      eocd = await findEocd(this.reader, false, signal);
    } catch (err) {
      addIssue(issueFromError(err));
      return finalizeAuditReport(issues, summary);
    }

    for (const warning of eocd.warnings) {
      addParseWarning(warning);
    }

    const eocdEnd = eocd.eocdOffset + 22n + BigInt(eocd.comment.length);
    const trailingBytes = size > eocdEnd ? size - eocdEnd : 0n;
    if (trailingBytes > 0n) {
      const severity: ZipIssueSeverity = settings.rejectTrailingBytes ? 'error' : 'warning';
      const trailingBytesNumber = toSafeNumber(trailingBytes);
      if (trailingBytesNumber !== undefined) {
        summary.trailingBytes = trailingBytesNumber;
      }
      addIssue({
        code: 'ZIP_TRAILING_BYTES',
        severity,
        message: `Trailing bytes after EOCD: ${trailingBytes.toString()}`,
        offset: eocdEnd,
        details: { trailingBytes: trailingBytes.toString() }
      });
    }

    const cdEnd = eocd.cdOffset + eocd.cdSize;
    if (eocd.cdOffset < 0n || cdEnd > size) {
      addIssue({
        code: 'ZIP_OUT_OF_RANGE',
        severity: 'error',
        message: 'Central directory is outside file bounds',
        offset: eocd.cdOffset,
        details: {
          cdOffset: eocd.cdOffset.toString(),
          cdSize: eocd.cdSize.toString(),
          fileSize: size.toString()
        }
      });
    }

    try {
      for await (const entry of iterCentralDirectory(
        this.reader,
        eocd.cdOffset,
        eocd.cdSize,
        eocd.totalEntries,
        {
          strict: false,
          maxEntries: settings.limits.maxEntries,
          onWarning: addParseWarning,
          ...(signal ? { signal } : {})
        }
      )) {
        throwIfAborted(signal);
        summary.entries += 1;
        if (entry.encrypted) summary.encryptedEntries += 1;

        const count = seenNames.get(entry.name) ?? 0;
        if (count > 0) {
          addIssue({
            code: 'ZIP_DUPLICATE_ENTRY',
            severity: 'warning',
            message: `Duplicate entry name: ${entry.name}`,
            entryName: entry.name,
            details: { occurrences: count + 1 }
          });
        }
        seenNames.set(entry.name, count + 1);

        const lower = entry.name.toLocaleLowerCase('en-US');
        const existingLower = seenLower.get(lower);
        if (existingLower && existingLower !== entry.name) {
          addIssue({
            code: 'ZIP_CASE_COLLISION',
            severity: 'warning',
            message: `Case-insensitive name collision: ${existingLower} vs ${entry.name}`,
            entryName: entry.name,
            details: { otherName: existingLower }
          });
        } else {
          seenLower.set(lower, entry.name);
        }

        for (const issue of entryPathIssues(entry.name)) {
          addIssue(issue);
        }

        if (entry.isSymlink) {
          addIssue({
            code: 'ZIP_SYMLINK_PRESENT',
            severity: settings.symlinkSeverity,
            message: 'Symlink entry present',
            entryName: entry.name
          });
        }

        const aesExtra = entry.method === 99 ? parseAesExtra(entry.extra.get(0x9901) ?? new Uint8Array(0)) : undefined;

        if (entry.encrypted) {
          if ((entry.flags & 0x40) !== 0) {
            addIssue({
              code: 'ZIP_UNSUPPORTED_ENCRYPTION',
              severity: 'error',
              message: 'Strong encryption is not supported',
              entryName: entry.name
            });
            unsupportedEntries.add(entry.name);
          } else if (entry.method === 99 && !aesExtra) {
            addIssue({
              code: 'ZIP_UNSUPPORTED_ENCRYPTION',
              severity: 'error',
              message: 'AES encryption extra field missing or invalid',
              entryName: entry.name
            });
            unsupportedEntries.add(entry.name);
          }
        }

        const methodToCheck = entry.method === 99 ? aesExtra?.actualMethod : entry.method;
        if (methodToCheck !== undefined && !hasCompressionCodec(methodToCheck)) {
          addIssue({
            code: 'ZIP_UNSUPPORTED_METHOD',
            severity: 'error',
            message: `Unsupported compression method ${methodToCheck}`,
            entryName: entry.name,
            details: { method: methodToCheck }
          });
          unsupportedEntries.add(entry.name);
        }

        if (entry.uncompressedSize > settings.limits.maxUncompressedEntryBytes) {
          addIssue({
            code: 'ZIP_LIMIT_EXCEEDED',
            severity: 'error',
            message: 'Entry exceeds max uncompressed size',
            entryName: entry.name,
            details: {
              limit: settings.limits.maxUncompressedEntryBytes.toString(),
              size: entry.uncompressedSize.toString()
            }
          });
        }

        totalUncompressed += entry.uncompressedSize;
        if (!totalExceeded && totalUncompressed > settings.limits.maxTotalUncompressedBytes) {
          totalExceeded = true;
          addIssue({
            code: 'ZIP_LIMIT_EXCEEDED',
            severity: 'error',
            message: 'Total uncompressed size exceeds limit',
            details: {
              limit: settings.limits.maxTotalUncompressedBytes.toString(),
              size: totalUncompressed.toString()
            }
          });
        }

        if (entry.compressedSize > 0n) {
          const ratio = Number(entry.uncompressedSize) / Number(entry.compressedSize);
          if (ratio > settings.limits.maxCompressionRatio) {
            addIssue({
              code: 'ZIP_LIMIT_EXCEEDED',
              severity: settings.strict ? 'error' : 'warning',
              message: 'Compression ratio exceeds safety limit',
              entryName: entry.name,
              details: { ratio, limit: settings.limits.maxCompressionRatio }
            });
          }
        }

        if (entry.offset < 0n || entry.offset >= size) {
          addIssue({
            code: 'ZIP_OUT_OF_RANGE',
            severity: 'error',
            message: 'Local header offset is outside file bounds',
            entryName: entry.name,
            offset: entry.offset,
            details: { offset: entry.offset.toString(), fileSize: size.toString() }
          });
          continue;
        }

        try {
          const local = await readLocalHeader(this.reader, entry, signal);
          const mismatchDetails = collectHeaderMismatches(entry, local);
          if (mismatchDetails) {
            addIssue({
              code: 'ZIP_HEADER_MISMATCH',
              severity: 'error',
              message: 'Local header does not match central directory',
              entryName: entry.name,
              offset: entry.offset,
              details: mismatchDetails
            });
          }

          const dataEnd = local.dataOffset + entry.compressedSize;
          if (dataEnd > size) {
            addIssue({
              code: 'ZIP_OUT_OF_RANGE',
              severity: 'error',
              message: 'Entry data extends beyond file bounds',
              entryName: entry.name,
              offset: local.dataOffset,
              details: {
                dataOffset: local.dataOffset.toString(),
                dataEnd: dataEnd.toString(),
                fileSize: size.toString()
              }
            });
          } else {
            ranges.push({ start: entry.offset, end: dataEnd, entryName: entry.name });
            if (dataEnd > eocd.cdOffset) {
              addIssue({
                code: 'ZIP_OUT_OF_RANGE',
                severity: 'error',
                message: 'Entry data overlaps central directory',
                entryName: entry.name,
                details: {
                  dataEnd: dataEnd.toString(),
                  cdOffset: eocd.cdOffset.toString()
                }
              });
            }
          }
        } catch (err) {
          const details = errorDetails(err);
          addIssue({
            code: 'ZIP_HEADER_MISMATCH',
            severity: 'error',
            message: 'Failed to read local header',
            entryName: entry.name,
            offset: entry.offset,
            ...(details ? { details } : {})
          });
        }
      }
    } catch (err) {
      addIssue(issueFromError(err));
    }

    ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    for (let i = 1; i < ranges.length; i += 1) {
      const prev = ranges[i - 1]!;
      const curr = ranges[i]!;
      if (curr.start < prev.end) {
        addIssue({
          code: 'ZIP_OVERLAPPING_ENTRIES',
          severity: 'error',
          message: 'Entry data ranges overlap',
          entryName: curr.entryName,
          details: {
            previousEntry: prev.entryName,
            previousEnd: prev.end.toString(),
            currentStart: curr.start.toString()
          }
        });
      }
    }

    summary.unsupportedEntries = unsupportedEntries.size;
    return finalizeAuditReport(issues, summary);
  }

  async assertSafe(options?: ZipAuditOptions): Promise<void> {
    const report = await this.audit(options);
    const profile = options?.profile ?? this.profile;
    const treatWarningsAsErrors = profile === 'agent';
    const ok = report.ok && (!treatWarningsAsErrors || report.summary.warnings === 0);
    if (ok) return;
    const message = treatWarningsAsErrors
      ? 'ZIP audit reported warnings or errors'
      : 'ZIP audit reported errors';
    throw new ZipError('ZIP_AUDIT_FAILED', message, { cause: report });
  }

  async close(): Promise<void> {
    await this.reader.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async init(): Promise<void> {
    const eocd = await findEocd(this.reader, this.strict, this.signal);
    this.warningsList.push(...eocd.warnings);
    this.eocd = eocd;

    if (this.storeEntries) {
      await this.loadEntries();
    }
  }

  private async loadEntries(): Promise<void> {
    if (this.entriesList) return;
    for await (const _ of this.iterEntries()) {
      // iterEntries populates entriesList when storeEntries is enabled.
    }
  }

  private applyEntryLimits(entry: ZipEntryRecord, totals: { totalUncompressed: bigint }): void {
    if (entry.uncompressedSize > this.limits.maxUncompressedEntryBytes) {
      throw new ZipError('ZIP_LIMIT_EXCEEDED', 'Entry exceeds max uncompressed size', {
        entryName: entry.name
      });
    }
    totals.totalUncompressed += entry.uncompressedSize;
    if (totals.totalUncompressed > this.limits.maxTotalUncompressedBytes) {
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

  private resolveAuditSettings(options?: ZipAuditOptions): {
    profile: ZipProfile;
    strict: boolean;
    limits: Required<ZipLimits>;
    rejectTrailingBytes: boolean;
    symlinkSeverity: ZipIssueSeverity;
  } {
    const profile = options?.profile ?? this.profile;
    const defaults =
      profile === this.profile
        ? { strict: this.strict, limits: this.limits }
        : resolveProfileDefaults(profile);
    const strict = options?.strict ?? defaults.strict;
    const limits = normalizeLimits(options?.limits, defaults.limits);
    return {
      profile,
      strict,
      limits,
      rejectTrailingBytes: profile === 'agent',
      symlinkSeverity: profile === 'agent' ? 'error' : 'warning'
    };
  }

  private resolveSignal(signal?: AbortSignal): AbortSignal | undefined {
    return mergeSignals(this.signal, signal);
  }

  private async normalizeToSink(sink: Sink, options?: ZipNormalizeOptions): Promise<ZipNormalizeReport> {
    const signal = this.resolveSignal(options?.signal);
    throwIfAborted(signal);
    const mode: 'safe' | 'lossless' = options?.mode ?? 'safe';
    const deterministic = options?.deterministic ?? true;
    const onDuplicate: ZipNormalizeConflict = options?.onDuplicate ?? 'error';
    const onCaseCollision: ZipNormalizeConflict = options?.onCaseCollision ?? 'error';
    const onUnsupported = options?.onUnsupported ?? 'error';
    const onSymlink = options?.onSymlink ?? 'error';
    const preserveComments = options?.preserveComments ?? false;
    const preserveTrailingBytes = options?.preserveTrailingBytes ?? false;
    const limits = normalizeLimits(options?.limits, this.limits);
    const outputMethod = options?.method ?? 8;
    const password = options?.password ?? this.password;
    const fixedMtime = new Date(1980, 0, 1, 0, 0, 0);

    const issues: ZipIssue[] = [];
    const summary: ZipNormalizeReport['summary'] = {
      entries: 0,
      encryptedEntries: 0,
      unsupportedEntries: 0,
      warnings: 0,
      errors: 0,
      outputEntries: 0,
      droppedEntries: 0,
      renamedEntries: 0,
      recompressedEntries: 0,
      preservedEntries: 0
    };

    const addIssue = (issue: ZipIssue) => {
      issues.push(issue);
      if (issue.severity === 'warning') summary.warnings += 1;
      if (issue.severity === 'error') summary.errors += 1;
    };

    const normalizedEntries = await this.collectNormalizedEntries({
      ...(signal ? { signal } : {}),
      deterministic,
      onDuplicate,
      onCaseCollision,
      onSymlink,
      issues,
      addIssue,
      summary
    });

    const results: EntryWriteResult[] = [];
    const totals = { totalUncompressed: 0n };
    let outputIndex = 0;
    let tempDir: string | null = null;
    if (mode === 'safe') {
      tempDir = await mkdtemp(path.join(tmpdir(), 'zip-next-normalize-'));
    }

    try {
      for (const item of normalizedEntries) {
        throwIfAborted(signal);
        if (item.dropped) continue;
        const entry = item.entry;
        if (entry.encrypted) summary.encryptedEntries += 1;

        const name = item.normalizedName;
        const mtime = deterministic ? fixedMtime : entry.mtime;
        const externalAttributes = deterministic ? (entry.isDirectory ? 0x10 : 0) : entry.externalAttributes;
        const comment = preserveComments && !deterministic ? entry.comment : undefined;
        const aesExtra = entry.method === 99 ? parseAesExtra(entry.extra.get(0x9901) ?? new Uint8Array(0)) : undefined;

        if (entry.method === 99 && !aesExtra) {
          addIssue({
            code: 'ZIP_UNSUPPORTED_ENCRYPTION',
            severity: 'error',
            message: 'AES extra field missing; cannot normalize entry',
            entryName: entry.name
          });
          summary.unsupportedEntries += 1;
          if (onUnsupported === 'drop') {
            summary.droppedEntries += 1;
            continue;
          }
          throw new ZipError('ZIP_UNSUPPORTED_ENCRYPTION', 'Missing AES extra field', {
            entryName: entry.name
          });
        }

        if (entry.isSymlink) {
          if (onSymlink === 'drop') {
            summary.droppedEntries += 1;
            addIssue({
              code: 'ZIP_SYMLINK_PRESENT',
              severity: 'warning',
              message: 'Symlink entry dropped during normalization',
              entryName: entry.name
            });
            continue;
          }
          if (onSymlink === 'error') {
            addIssue({
              code: 'ZIP_SYMLINK_PRESENT',
              severity: 'error',
              message: 'Symlink entries are not allowed during normalization',
              entryName: entry.name
            });
            throw new ZipError('ZIP_SYMLINK_DISALLOWED', 'Symlink entries are not allowed during normalization', {
              entryName: entry.name
            });
          }
        }

        if (mode === 'safe') {
          const methodToCheck = entry.method === 99 ? aesExtra?.actualMethod : entry.method;
          if (methodToCheck !== undefined && !hasCompressionCodec(methodToCheck)) {
            addIssue({
              code: 'ZIP_UNSUPPORTED_METHOD',
              severity: 'error',
              message: `Unsupported compression method ${methodToCheck}`,
              entryName: entry.name,
              details: { method: methodToCheck }
            });
            summary.unsupportedEntries += 1;
            if (onUnsupported === 'drop') {
              summary.droppedEntries += 1;
              continue;
            }
            throw new ZipError('ZIP_UNSUPPORTED_METHOD', `Unsupported compression method ${methodToCheck}`, {
              entryName: entry.name,
              method: methodToCheck
            });
          }

          const method = entry.isDirectory ? 0 : outputMethod;
          const codec = getCompressionCodec(method);
          if (!codec || !codec.createCompressStream) {
            addIssue({
              code: 'ZIP_UNSUPPORTED_METHOD',
              severity: 'error',
              message: `Unsupported compression method ${method}`,
              entryName: entry.name,
              details: { method }
            });
            summary.unsupportedEntries += 1;
            if (onUnsupported === 'drop') {
              summary.droppedEntries += 1;
              continue;
            }
            throw new ZipError('ZIP_UNSUPPORTED_METHOD', `Unsupported compression method ${method}`, {
              entryName: entry.name,
              method
            });
          }

          if (entry.encrypted && !password) {
            addIssue({
              code: 'ZIP_PASSWORD_REQUIRED',
              severity: 'error',
              message: 'Password required for encrypted entry during normalization',
              entryName: entry.name
            });
            if (onUnsupported === 'drop') {
              summary.droppedEntries += 1;
              continue;
            }
            throw new ZipError('ZIP_PASSWORD_REQUIRED', 'Password required for encrypted entry', {
              entryName: entry.name
            });
          }

          let source: ReadableStream<Uint8Array>;
          if (entry.isDirectory) {
            source = readableFromBytes(new Uint8Array(0));
          } else {
            source = await openEntryStream(this.reader, entry, {
              strict: true,
              onWarning: (warning) =>
                addIssue({
                  code: warning.code,
                  severity: 'warning',
                  message: warning.message,
                  ...(warning.entryName ? { entryName: warning.entryName } : {})
                }),
              ...(password !== undefined ? { password } : {}),
              ...(signal ? { signal } : {}),
              ...progressParams(options),
              limits,
              totals
            });
          }

          if (!tempDir) {
            throw new ZipError('ZIP_UNSUPPORTED_FEATURE', 'Normalization temp directory missing');
          }
          const tempPath = path.join(tempDir, `entry-${outputIndex + 1}.bin`);
          const spool = await spoolCompressedEntry({
            source,
            method,
            entryName: name,
            ...(signal ? { signal } : {}),
            progress: progressParams(options),
            tempPath
          });

          const dataStream = toWebReadable(createReadStream(tempPath));
          const flags = 0x800;
          const result = await writeRawEntry(sink, {
            name,
            source: dataStream,
            method,
            flags,
            crc32: spool.crc32,
            compressedSize: spool.compressedSize,
            uncompressedSize: spool.uncompressedSize,
            mtime,
            comment,
            externalAttributes,
            zip64Mode: 'auto',
            forceZip64: false,
            ...(signal ? { signal } : {}),
            ...(options ? { progress: progressParams(options) } : {})
          });
          results.push(result);
          summary.outputEntries += 1;
          outputIndex += 1;
          summary.recompressedEntries += entry.isDirectory ? 0 : 1;
          await rm(tempPath, { force: true }).catch(() => {});
          continue;
        }

        // lossless mode
        const methodToCheck = entry.method === 99 ? aesExtra?.actualMethod : entry.method;
        if (methodToCheck !== undefined && !hasCompressionCodec(methodToCheck)) {
          summary.unsupportedEntries += 1;
          addIssue({
            code: 'ZIP_UNSUPPORTED_METHOD',
            severity: 'warning',
            message: `Unsupported compression method ${methodToCheck} preserved in lossless mode`,
            entryName: entry.name,
            details: { method: methodToCheck }
          });
        }

        const { stream: rawStream } = await openRawStream(this.reader, entry, {
          ...(signal ? { signal } : {}),
          ...progressParams(options)
        });
        const flags = 0x800 | (entry.encrypted ? 0x01 : 0);
        const aesExtraBytes = aesExtra
          ? buildAesExtra({
              vendorVersion: aesExtra.vendorVersion,
              strength: aesExtra.strength,
              actualMethod: aesExtra.actualMethod
            })
          : undefined;

        const result = await writeRawEntry(sink, {
          name,
          source: rawStream,
          method: entry.method,
          flags,
          crc32: entry.crc32,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          mtime,
          comment,
          externalAttributes,
          zip64Mode: 'auto',
          forceZip64: false,
          ...(aesExtraBytes ? { aesExtra: aesExtraBytes } : {}),
          ...(signal ? { signal } : {}),
          ...(options ? { progress: progressParams(options) } : {})
        });
        results.push(result);
        summary.outputEntries += 1;
        outputIndex += 1;
        summary.preservedEntries += 1;
      }

      const cdInfo = await writeCentralDirectory(sink, results, signal);
      const finalizeOptions = {
        entryCount: BigInt(results.length),
        cdOffset: cdInfo.offset,
        cdSize: cdInfo.size,
        forceZip64: false,
        hasZip64Entries: results.some((entry) => entry.zip64)
      } as const;
      await finalizeArchive(sink, finalizeOptions, signal);

      if (preserveTrailingBytes) {
        const trailing = await readTrailingBytes(this.reader, this.eocd, signal);
        if (trailing.length > 0) {
          await sink.write(trailing);
        }
      }

      await sink.close();
    } catch (err) {
      await sink.close().catch(() => {});
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
      throw err;
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    summary.entries = normalizedEntries.length;
    const report = finalizeNormalizeReport(issues, summary);
    return report;
  }

  private async collectNormalizedEntries(params: {
    signal?: AbortSignal;
    deterministic: boolean;
    onDuplicate: ZipNormalizeConflict;
    onCaseCollision: ZipNormalizeConflict;
    onSymlink: 'error' | 'drop';
    issues: ZipIssue[];
    addIssue: (issue: ZipIssue) => void;
    summary: ZipNormalizeReport['summary'];
  }): Promise<NormalizedEntry[]> {
    const entries: NormalizedEntry[] = [];
    const nameIndex = new Map<string, number>();
    const lowerIndex = new Map<string, string>();

    const iterOptions = params.signal ? { signal: params.signal } : undefined;
    for await (const entry of this.iterEntries(iterOptions)) {
      params.summary.entries += 1;
      const normalizedName = normalizeEntryName(entry.name, entry.isDirectory, params.addIssue);
      let targetName = normalizedName;
      let renamed = false;

      const existingIndex = nameIndex.get(targetName);
      if (existingIndex !== undefined) {
        if (params.onDuplicate === 'error') {
          params.addIssue({
            code: 'ZIP_DUPLICATE_ENTRY',
            severity: 'error',
            message: `Duplicate entry name: ${targetName}`,
            entryName: entry.name
          });
          throw new ZipError('ZIP_BAD_CENTRAL_DIRECTORY', 'Duplicate entry name', { entryName: entry.name });
        }
        if (params.onDuplicate === 'last-wins') {
          entries[existingIndex]!.dropped = true;
          params.summary.droppedEntries += 1;
          params.addIssue({
            code: 'ZIP_DUPLICATE_ENTRY',
            severity: 'warning',
            message: `Duplicate entry name replaced by last occurrence: ${targetName}`,
            entryName: entry.name
          });
        } else if (params.onDuplicate === 'rename') {
          targetName = resolveConflictName(targetName, nameIndex, lowerIndex);
          renamed = true;
        }
      }

      const lower = targetName.toLocaleLowerCase('en-US');
      const existingLower = lowerIndex.get(lower);
      if (existingLower && existingLower !== targetName) {
        if (params.onCaseCollision === 'error') {
          params.addIssue({
            code: 'ZIP_CASE_COLLISION',
            severity: 'error',
            message: `Case-insensitive name collision: ${existingLower} vs ${targetName}`,
            entryName: entry.name
          });
          throw new ZipError('ZIP_BAD_CENTRAL_DIRECTORY', 'Case-insensitive name collision', { entryName: entry.name });
        }
        if (params.onCaseCollision === 'last-wins') {
          const previous = nameIndex.get(existingLower);
          if (previous !== undefined) {
            entries[previous]!.dropped = true;
            params.summary.droppedEntries += 1;
          }
          params.addIssue({
            code: 'ZIP_CASE_COLLISION',
            severity: 'warning',
            message: `Case-insensitive collision replaced by last occurrence: ${targetName}`,
            entryName: entry.name
          });
        } else if (params.onCaseCollision === 'rename') {
          targetName = resolveConflictName(targetName, nameIndex, lowerIndex);
          renamed = true;
        }
      }

      nameIndex.set(targetName, entries.length);
      lowerIndex.set(targetName.toLocaleLowerCase('en-US'), targetName);

      if (renamed) {
        params.summary.renamedEntries += 1;
        params.addIssue({
          code: 'ZIP_NORMALIZED_NAME',
          severity: 'info',
          message: `Entry renamed to ${targetName}`,
          entryName: entry.name,
          details: { normalizedName: targetName }
        });
      } else if (targetName !== entry.name) {
        params.addIssue({
          code: 'ZIP_NORMALIZED_NAME',
          severity: 'info',
          message: `Entry name normalized to ${targetName}`,
          entryName: entry.name,
          details: { normalizedName: targetName }
        });
      }

      entries.push({
        entry: entry as ZipEntryRecord,
        normalizedName: targetName,
        dropped: false
      });
    }

    if (params.deterministic) {
      entries.sort((a, b) => (a.normalizedName < b.normalizedName ? -1 : a.normalizedName > b.normalizedName ? 1 : 0));
    }

    return entries;
  }
}

type NormalizedEntry = {
  entry: ZipEntryRecord;
  normalizedName: string;
  dropped: boolean;
};

function normalizeEntryName(
  entryName: string,
  isDirectory: boolean,
  addIssue: (issue: ZipIssue) => void
): string {
  if (entryName.includes('\u0000')) {
    addIssue({
      code: 'ZIP_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Entry name contains NUL byte',
      entryName
    });
    throw new ZipError('ZIP_PATH_TRAVERSAL', 'Entry name contains NUL byte', { entryName });
  }
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    addIssue({
      code: 'ZIP_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Absolute paths are not allowed in ZIP entries',
      entryName
    });
    throw new ZipError('ZIP_PATH_TRAVERSAL', 'Absolute paths are not allowed in ZIP entries', { entryName });
  }
  const parts = normalized.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.some((part) => part === '..')) {
    addIssue({
      code: 'ZIP_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Path traversal detected in ZIP entry',
      entryName
    });
    throw new ZipError('ZIP_PATH_TRAVERSAL', 'Path traversal detected in ZIP entry', { entryName });
  }
  let name = parts.join('/');
  if (isDirectory && !name.endsWith('/')) {
    name = name.length > 0 ? `${name}/` : '';
  }
  if (name.length === 0) {
    addIssue({
      code: 'ZIP_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Entry name resolves to empty path',
      entryName
    });
    throw new ZipError('ZIP_PATH_TRAVERSAL', 'Entry name resolves to empty path', { entryName });
  }
  return name;
}

function resolveConflictName(
  name: string,
  nameIndex: Map<string, number>,
  lowerIndex: Map<string, string>
): string {
  const trailingSlash = name.endsWith('/');
  const trimmed = trailingSlash ? name.slice(0, -1) : name;
  const slashIndex = trimmed.lastIndexOf('/');
  const dir = slashIndex >= 0 ? trimmed.slice(0, slashIndex + 1) : '';
  const file = slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
  const dotIndex = file.lastIndexOf('.');
  const base = dotIndex > 0 ? file.slice(0, dotIndex) : file;
  const ext = dotIndex > 0 ? file.slice(dotIndex) : '';
  let counter = 1;
  while (true) {
    const candidate = `${dir}${base}~${counter}${ext}${trailingSlash ? '/' : ''}`;
    const lower = candidate.toLocaleLowerCase('en-US');
    if (!nameIndex.has(candidate) && !lowerIndex.has(lower)) {
      return candidate;
    }
    counter += 1;
  }
}

async function spoolCompressedEntry(options: {
  source: ReadableStream<Uint8Array>;
  method: number;
  entryName: string;
  tempPath: string;
  signal?: AbortSignal;
  progress?: ZipProgressOptions;
}): Promise<{ compressedSize: bigint; uncompressedSize: bigint; crc32: number }> {
  const codec = getCompressionCodec(options.method);
  if (!codec || !codec.createCompressStream) {
    throw new ZipError('ZIP_UNSUPPORTED_METHOD', `Unsupported compression method ${options.method}`, {
      entryName: options.entryName,
      method: options.method
    });
  }
  const crcResult = { crc32: 0, bytes: 0n };
  const measure = { bytes: 0n };
  const compressTracker = createProgressTracker(options.progress, {
    kind: 'compress',
    entryName: options.entryName
  });
  const writeTracker = createProgressTracker(options.progress, {
    kind: 'write',
    entryName: options.entryName
  });
  let stream = options.source;
  stream = stream.pipeThrough(createCrcTransform(crcResult, { strict: true }));
  stream = stream.pipeThrough(createProgressTransform(compressTracker));
  stream = stream.pipeThrough(codec.createCompressStream());
  stream = stream.pipeThrough(createMeasureTransform(measure));

  const sink = new NodeWritableSink(createWriteStream(options.tempPath));
  try {
    await pipeToSink(stream, sink, options.signal, writeTracker);
    await sink.close();
  } catch (err) {
    await sink.close().catch(() => {});
    throw err;
  }

  return {
    compressedSize: measure.bytes,
    uncompressedSize: crcResult.bytes,
    crc32: crcResult.crc32
  };
}

async function pipeToSink(
  stream: ReadableStream<Uint8Array>,
  sink: Sink,
  signal?: AbortSignal,
  tracker?: ReturnType<typeof createProgressTracker>
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        await sink.write(value);
        tracker?.update(value.length, value.length);
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
  tracker?.flush();
}

async function readTrailingBytes(
  reader: RandomAccess,
  eocd: EocdResult | null,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (!eocd) return new Uint8Array(0);
  const size = await reader.size(signal);
  const eocdEnd = eocd.eocdOffset + 22n + BigInt(eocd.comment.length);
  if (size <= eocdEnd) return new Uint8Array(0);
  const trailing = size - eocdEnd;
  const trailingNumber = toSafeNumber(trailing);
  if (trailingNumber === undefined) {
    throw new ZipError('ZIP_LIMIT_EXCEEDED', 'Trailing bytes too large to preserve');
  }
  return reader.read(eocdEnd, trailingNumber, signal);
}

function finalizeNormalizeReport(issues: ZipIssue[], summary: ZipNormalizeReport['summary']): ZipNormalizeReport {
  const report = {
    ok: summary.errors === 0,
    summary,
    issues
  } as ZipNormalizeReport & { toJSON: () => unknown };
  report.toJSON = () => ({
    ok: report.ok,
    summary: report.summary,
    issues: issues.map(issueToJson)
  });
  return report;
}

function resolveReaderProfile(options?: ZipReaderOptions): {
  profile: ZipProfile;
  strict: boolean;
  limits: Required<ZipLimits>;
} {
  const profile = options?.profile ?? 'strict';
  const defaults = profile === 'agent' ? AGENT_LIMITS : DEFAULT_LIMITS;
  const strictDefault = profile === 'compat' ? false : true;
  const strict = options?.strict ?? strictDefault;
  const limits = normalizeLimits(options?.limits, defaults);
  return { profile, strict, limits };
}

function resolveProfileDefaults(profile: ZipProfile): { strict: boolean; limits: Required<ZipLimits> } {
  if (profile === 'compat') {
    return { strict: false, limits: DEFAULT_LIMITS };
  }
  if (profile === 'agent') {
    return { strict: true, limits: AGENT_LIMITS };
  }
  return { strict: true, limits: DEFAULT_LIMITS };
}

function normalizeLimits(limits?: ZipLimits, defaults: Required<ZipLimits> = DEFAULT_LIMITS): Required<ZipLimits> {
  return {
    maxEntries: limits?.maxEntries ?? defaults.maxEntries,
    maxUncompressedEntryBytes: toBigInt(limits?.maxUncompressedEntryBytes) ?? defaults.maxUncompressedEntryBytes,
    maxTotalUncompressedBytes: toBigInt(limits?.maxTotalUncompressedBytes) ?? defaults.maxTotalUncompressedBytes,
    maxCompressionRatio: limits?.maxCompressionRatio ?? defaults.maxCompressionRatio
  };
}

function progressParams(options?: ZipProgressOptions): Partial<ZipProgressOptions> {
  if (!options) return {};
  const out: Partial<ZipProgressOptions> = {};
  if (options.onProgress) out.onProgress = options.onProgress;
  if (options.progressIntervalMs !== undefined) out.progressIntervalMs = options.progressIntervalMs;
  if (options.progressChunkInterval !== undefined) out.progressChunkInterval = options.progressChunkInterval;
  return out;
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

function entryPathIssues(entryName: string): ZipIssue[] {
  const issues: ZipIssue[] = [];
  if (entryName.includes('\u0000')) {
    issues.push({
      code: 'ZIP_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Entry name contains NUL byte',
      entryName
    });
    return issues;
  }
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    issues.push({
      code: 'ZIP_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Absolute paths are not allowed in ZIP entries',
      entryName
    });
  }
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.some((part) => part === '..')) {
    issues.push({
      code: 'ZIP_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Path traversal detected in ZIP entry',
      entryName
    });
  }
  return issues;
}

function collectHeaderMismatches(entry: ZipEntryRecord, local: LocalHeaderInfo): Record<string, unknown> | undefined {
  const details: Record<string, unknown> = {};
  if (entry.flags !== local.flags) {
    details.flags = { local: local.flags, central: entry.flags };
  }
  if (entry.method !== local.method) {
    details.method = { local: local.method, central: entry.method };
  }
  if (local.nameLen !== entry.rawNameBytes.length) {
    details.nameLength = { local: local.nameLen, central: entry.rawNameBytes.length };
  }
  if (!bytesEqual(local.nameBytes, entry.rawNameBytes)) {
    details.nameBytes = { mismatch: true };
  }
  if (local.extraLen !== entry.extraLength) {
    details.extraLength = { local: local.extraLen, central: entry.extraLength };
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function issueFromError(err: unknown): ZipIssue {
  if (err instanceof ZipError) {
    return {
      code: err.code,
      severity: 'error',
      message: err.message,
      ...(err.entryName ? { entryName: err.entryName } : {}),
      ...(err.offset !== undefined ? { offset: err.offset } : {}),
      ...(err.cause ? { details: { cause: String(err.cause) } } : {})
    };
  }
  if (err instanceof Error) {
    return {
      code: 'ZIP_AUDIT_ERROR',
      severity: 'error',
      message: err.message,
      details: { name: err.name }
    };
  }
  return {
    code: 'ZIP_AUDIT_ERROR',
    severity: 'error',
    message: 'Unknown audit error'
  };
}

function errorDetails(err: unknown): Record<string, unknown> | undefined {
  if (err instanceof ZipError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { value: String(err) };
}

function toSafeNumber(value: bigint): number | undefined {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(value);
}

function finalizeAuditReport(issues: ZipIssue[], summary: ZipAuditReport['summary']): ZipAuditReport {
  const report = {
    ok: summary.errors === 0,
    summary,
    issues
  } as ZipAuditReport & { toJSON: () => unknown };
  report.toJSON = () => ({
    ok: report.ok,
    summary: report.summary,
    issues: issues.map(issueToJson)
  });
  return report;
}

function issueToJson(issue: ZipIssue): Record<string, unknown> {
  return {
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    ...(issue.entryName ? { entryName: issue.entryName } : {}),
    ...(issue.offset !== undefined ? { offset: issue.offset.toString() } : {}),
    ...(issue.details ? { details: sanitizeDetails(issue.details) } : {})
  };
}

function sanitizeDetails(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(sanitizeDetails);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeDetails(val);
    }
    return out;
  }
  return value;
}

class TempFileRandomAccess implements RandomAccess {
  private readonly inner: FileRandomAccess;

  constructor(
    private readonly filePath: string,
    private readonly tempDir: string
  ) {
    this.inner = FileRandomAccess.fromPath(filePath);
  }

  size(signal?: AbortSignal): Promise<bigint> {
    return this.inner.size(signal);
  }

  read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.inner.read(offset, length, signal);
  }

  async close(): Promise<void> {
    await this.inner.close();
    await rm(this.tempDir, { recursive: true, force: true });
  }
}
