import { ZipError } from '../errors.js';
import { mergeSignals, throwIfAborted } from '../abort.js';
import { BYTEFOLD_REPORT_SCHEMA_VERSION } from '../reportSchema.js';
import type {
  ZipAuditOptions,
  ZipAuditReport,
  ZipEntry,
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
import { BufferRandomAccess, HttpRandomAccess, type RandomAccess } from './RandomAccess.js';
import { wrapRandomAccessForZip } from './httpZipErrors.js';
import { findEocd, type EocdResult } from './eocd.js';
import { iterCentralDirectory, type ZipEntryRecord } from './centralDirectory.js';
import { openEntryStream, openRawStream, type OpenEntryOptions } from './entryStream.js';
import { buildAesExtra, parseAesExtra } from '../extraFields.js';
import { readLocalHeader, type LocalHeaderInfo } from './localHeader.js';
import { readableFromBytes } from '../streams/web.js';
import { readAllBytes } from '../streams/buffer.js';
import { createCrcTransform } from '../streams/crcTransform.js';
import { createProgressTracker, createProgressTransform } from '../streams/progress.js';
import { normalizePathForCollision, toCollisionKey } from '../text/caseFold.js';
import { WebWritableSink, type Sink } from '../writer/Sink.js';
import { writeCentralDirectory } from '../writer/centralDirectoryWriter.js';
import { finalizeArchive } from '../writer/finalize.js';
import { writeRawEntry, type EntryWriteResult } from '../writer/entryWriter.js';
import { getCompressionCodec, hasCompressionCodec } from '../compression/registry.js';
import { AGENT_RESOURCE_LIMITS, DEFAULT_RESOURCE_LIMITS } from '../limits.js';

const DEFAULT_LIMITS: Required<ZipLimits> = DEFAULT_RESOURCE_LIMITS;
const AGENT_LIMITS: Required<ZipLimits> = AGENT_RESOURCE_LIMITS;

/** Read ZIP archives from bytes, streams, or URLs. */
export class ZipReader {
  /** @internal */
  protected readonly profile: ZipProfile;
  /** @internal */
  protected readonly strict: boolean;
  /** @internal */
  protected readonly limits: Required<ZipLimits>;
  /** @internal */
  protected readonly warningsList: ZipWarning[] = [];
  /** @internal */
  protected entriesList: ZipEntryRecord[] | null = null;
  /** @internal */
  protected readonly password: string | undefined;
  /** @internal */
  protected readonly storeEntries: boolean;
  /** @internal */
  protected eocd: EocdResult | null = null;
  /** @internal */
  protected readonly signal: AbortSignal | undefined;
  /** @internal */
  protected readonly reader: RandomAccess;

  /** @internal */
  protected constructor(
    reader: RandomAccess,
    options?: ZipReaderOptions
  ) {
    const resolved = resolveReaderProfile(options);
    this.reader = reader;
    this.profile = resolved.profile;
    this.strict = resolved.strict;
    this.limits = resolved.limits;
    this.password = options?.password;
    this.storeEntries = options?.shouldStoreEntries ?? true;
    this.signal = mergeSignals(options?.signal, options?.http?.signal);
  }

  /** @internal */
  static async fromRandomAccess(reader: RandomAccess, options?: ZipReaderOptions): Promise<ZipReader> {
    const instance = new ZipReader(wrapRandomAccessForZip(reader), options);
    await instance.init();
    return instance;
  }

  /** Create a reader from in-memory bytes. */
  static async fromUint8Array(data: Uint8Array, options?: ZipReaderOptions): Promise<ZipReader> {
    const reader = new BufferRandomAccess(data);
    const instance = new ZipReader(wrapRandomAccessForZip(reader), options);
    await instance.init();
    return instance;
  }

  /** Create a reader from a readable stream. */
  static async fromStream(
    stream: ReadableStream<Uint8Array>,
    options?: ZipReaderOptions
  ): Promise<ZipReader> {
    const readOptions: { signal?: AbortSignal; maxBytes?: bigint | number } = {};
    if (options?.signal) readOptions.signal = options.signal;
    if (options?.limits?.maxInputBytes !== undefined) {
      readOptions.maxBytes = options.limits.maxInputBytes;
    } else if (options?.limits?.maxTotalDecompressedBytes !== undefined) {
      readOptions.maxBytes = options.limits.maxTotalDecompressedBytes;
    } else if (options?.limits?.maxTotalUncompressedBytes !== undefined) {
      readOptions.maxBytes = options.limits.maxTotalUncompressedBytes;
    }
    const data = await readAllBytes(stream, readOptions);
    return ZipReader.fromUint8Array(data, options);
  }

  /** Create a reader from a URL using HTTP range requests when possible. */
  static async fromUrl(
    url: string | URL,
    options?: ZipReaderOptions & {
      http?: {
        headers?: Record<string, string>;
        cache?: { blockSize?: number; maxBlocks?: number };
        signal?: AbortSignal;
        snapshotPolicy?: 'require-strong-etag' | 'best-effort';
      };
    }
  ): Promise<ZipReader> {
    const httpSignal = mergeSignals(options?.signal, options?.http?.signal);
    const httpOptions: {
      headers?: Record<string, string>;
      cache?: { blockSize?: number; maxBlocks?: number };
      signal?: AbortSignal;
      snapshotPolicy?: 'require-strong-etag' | 'best-effort';
    } = options?.http ? { ...options.http } : {};
    if (httpSignal) {
      httpOptions.signal = httpSignal;
    }
    const reader = new HttpRandomAccess(url, Object.keys(httpOptions).length > 0 ? httpOptions : undefined);
    const instance = new ZipReader(wrapRandomAccessForZip(reader), options);
    await instance.init();
    return instance;
  }

  /** Return stored entries (requires shouldStoreEntries=true). */
  entries(): ZipEntry[] {
    if (!this.storeEntries) {
      throw new ZipError(
        'ZIP_ENTRIES_NOT_STORED',
        'Entries are not stored; use iterEntries() or enable shouldStoreEntries'
      );
    }
    if (!this.entriesList) return [];
    return this.entriesList.map((entry) => ({ ...entry }));
  }

  /** Return non-fatal warnings encountered during parsing. */
  warnings(): ZipWarning[] {
    return [...this.warningsList];
  }

  /** Iterate entries lazily (or from cached entries). */
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

  /** Iterate entries with a callback. */
  async forEachEntry(fn: (entry: ZipEntry) => void | Promise<void>, options?: ZipReaderIterOptions): Promise<void> {
    for await (const entry of this.iterEntries(options)) {
      await fn(entry);
    }
  }

  /** Open a decoded stream for an entry. */
  async open(entry: ZipEntry, options?: ZipReaderOpenOptions): Promise<ReadableStream<Uint8Array>> {
    const strict = options?.isStrict ?? this.strict;
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
    return this.openEntryStream(entry as ZipEntryRecord, {
      ...params,
      ...(signal ? { signal } : {}),
      ...progressParams(options),
      limits: this.limits,
      totals
    });
  }

  /** Open a raw (compressed) stream for an entry. */
  async openRaw(entry: ZipEntry, options?: ZipReaderOpenOptions): Promise<ReadableStream<Uint8Array>> {
    const signal = this.resolveSignal(options?.signal);
    const { stream } = await openRawStream(this.reader, entry as ZipEntryRecord, {
      ...(signal ? { signal } : {}),
      ...progressParams(options)
    });
    return stream;
  }

  /** @internal */
  protected async openEntryStream(
    entry: ZipEntryRecord,
    options: OpenEntryOptions
  ): Promise<ReadableStream<Uint8Array>> {
    return openEntryStream(this.reader, entry, options);
  }

  /** Normalize to a writable stream, producing a report. */
  async normalizeToWritable(
    writable: WritableStream<Uint8Array>,
    options?: ZipNormalizeOptions
  ): Promise<ZipNormalizeReport> {
    const sink = new WebWritableSink(writable);
    return this.normalizeToSink(sink, options);
  }

  /** Audit the archive and return a report of issues. */
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
    const seenNames = new Map<string, { count: number; original: string }>();
    const seenNfc = new Map<string, { original: string; normalized: string }>();
    const seenCase = new Map<string, { original: string; nfc: string }>();
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
      eocd = await findEocd(this.reader, false, signal, {
        maxSearchBytes: settings.limits.maxZipEocdSearchBytes,
        maxCommentBytes: settings.limits.maxZipCommentBytes,
        maxCentralDirectoryBytes: settings.limits.maxZipCentralDirectoryBytes,
        maxEntries: settings.limits.maxEntries,
        rejectMultiDisk: true
      });
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
        offset: eocdEnd.toString(),
        details: { trailingBytes: trailingBytes.toString() }
      });
    }

    const cdEnd = eocd.cdOffset + eocd.cdSize;
    if (eocd.cdOffset < 0n || cdEnd > size) {
      addIssue({
        code: 'ZIP_OUT_OF_RANGE',
        severity: 'error',
        message: 'Central directory is outside file bounds',
        offset: eocd.cdOffset.toString(),
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

        const normalizedName = normalizePathForCollision(entry.name, entry.isDirectory);
        if (normalizedName) {
          const existing = seenNames.get(normalizedName);
          if (existing) {
            existing.count += 1;
            addIssue({
              code: 'ZIP_DUPLICATE_ENTRY',
              severity: 'warning',
              message: `Duplicate entry name: ${existing.original} vs ${entry.name}`,
              entryName: entry.name,
              details: {
                occurrences: existing.count,
                otherName: existing.original,
                key: normalizedName,
                collisionKind: 'duplicate'
              }
            });
          } else {
            seenNames.set(normalizedName, { count: 1, original: entry.name });
            const nfcName = normalizedName.normalize('NFC');
            const caseKey = toCollisionKey(normalizedName, entry.isDirectory);
            const existingNfc = seenNfc.get(nfcName);
            if (existingNfc && existingNfc.normalized !== normalizedName) {
              addIssue({
                code: 'ZIP_UNICODE_COLLISION',
                severity: 'error',
                message: `Unicode normalization collision: ${existingNfc.original} vs ${entry.name}`,
                entryName: entry.name,
                details: { otherName: existingNfc.original, key: nfcName, collisionKind: 'unicode_nfc' }
              });
            } else {
              const existingCase = seenCase.get(caseKey);
              if (existingCase && existingCase.nfc !== nfcName) {
                addIssue({
                  code: 'ZIP_CASE_COLLISION',
                  severity: 'warning',
                  message: `Case-insensitive name collision: ${existingCase.original} vs ${entry.name}`,
                  entryName: entry.name,
                  details: { otherName: existingCase.original, key: caseKey, collisionKind: 'casefold' }
                });
              }
            }
            seenNfc.set(nfcName, { original: entry.name, normalized: normalizedName });
            seenCase.set(caseKey, { original: entry.name, nfc: nfcName });
          }
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
            offset: entry.offset.toString(),
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
              offset: entry.offset.toString(),
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
              offset: local.dataOffset.toString(),
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
            offset: entry.offset.toString(),
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

  /** Audit and throw if the archive fails the selected profile. */
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

  /** Release underlying resources held by the reader. */
  async close(): Promise<void> {
    await this.reader.close();
  }

  /** Async dispose hook for using with `using` in supported runtimes. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** @internal */
  private async init(): Promise<void> {
    const eocd = await findEocd(this.reader, this.strict, this.signal, {
      maxSearchBytes: this.limits.maxZipEocdSearchBytes,
      maxCommentBytes: this.limits.maxZipCommentBytes,
      maxCentralDirectoryBytes: this.limits.maxZipCentralDirectoryBytes,
      maxEntries: this.limits.maxEntries,
      rejectMultiDisk: true
    });
    this.warningsList.push(...eocd.warnings);
    this.eocd = eocd;

    if (this.storeEntries) {
      await this.loadEntries();
    }
  }

  /** @internal */
  private async loadEntries(): Promise<void> {
    if (this.entriesList) return;
    for await (const _ of this.iterEntries()) {
      // iterEntries populates entriesList when storeEntries is enabled.
    }
  }

  /** @internal */
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

  /** @internal */
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
    const strict = options?.isStrict ?? defaults.strict;
    const limits = normalizeLimits(options?.limits, defaults.limits);
    return {
      profile,
      strict,
      limits,
      rejectTrailingBytes: profile === 'agent',
      symlinkSeverity: profile === 'agent' ? 'error' : 'warning'
    };
  }

  /** @internal */
  private resolveSignal(signal?: AbortSignal): AbortSignal | undefined {
    return mergeSignals(this.signal, signal);
  }

  /** @internal */
  private async normalizeToSink(sink: Sink, options?: ZipNormalizeOptions): Promise<ZipNormalizeReport> {
    const signal = this.resolveSignal(options?.signal);
    throwIfAborted(signal);
    const mode: 'safe' | 'lossless' = options?.mode ?? 'safe';
    const deterministic = options?.isDeterministic ?? true;
    const onDuplicate: ZipNormalizeConflict = options?.onDuplicate ?? 'error';
    const onCaseCollision: ZipNormalizeConflict = options?.onCaseCollision ?? 'error';
    const onUnsupported = options?.onUnsupported ?? 'error';
    const onSymlink = options?.onSymlink ?? 'error';
    const preserveComments = options?.shouldPreserveComments ?? false;
    const preserveTrailingBytes = options?.shouldPreserveTrailingBytes ?? false;
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

          if (entry.encrypted) {
            addIssue({
              code: 'ZIP_UNSUPPORTED_ENCRYPTION',
              severity: 'error',
              message: 'Encrypted entries are not supported during normalization in this runtime',
              entryName: entry.name
            });
            summary.unsupportedEntries += 1;
            if (onUnsupported === 'drop') {
              summary.droppedEntries += 1;
              continue;
            }
            throw new ZipError('ZIP_UNSUPPORTED_ENCRYPTION', 'Encrypted entries are not supported', {
              entryName: entry.name
            });
          }

          let source: ReadableStream<Uint8Array>;
          if (entry.isDirectory) {
            source = readableFromBytes(new Uint8Array(0));
          } else {
            source = await this.openEntryStream(entry, {
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

          const spool = await spoolCompressedEntryToMemory({
            source,
            method,
            entryName: name,
            ...(signal ? { signal } : {}),
            progress: progressParams(options)
          });

          const dataStream = readableFromBytes(spool.data);
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
          summary.recompressedEntries += entry.isDirectory ? 0 : 1;
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
      throw err;
    }

    summary.entries = normalizedEntries.length;
    const report = finalizeNormalizeReport(issues, summary);
    return report;
  }

  /** @internal */
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
    const caseIndex = new Map<string, { original: string; target: string; nfc: string }>();
    const nfcIndex = new Map<string, { original: string; target: string }>();
    const originalNames = new Map<string, string>();

    const iterOptions = params.signal ? { signal: params.signal } : undefined;
    for await (const entry of this.iterEntries(iterOptions)) {
      params.summary.entries += 1;
      const normalizedName = normalizeEntryName(entry.name, entry.isDirectory, params.addIssue);
      let targetName = normalizedName;
      let renamed = false;

      const existingIndex = nameIndex.get(targetName);
      if (existingIndex !== undefined) {
        if (params.onDuplicate === 'error') {
          const existingName = originalNames.get(targetName) ?? targetName;
          params.addIssue({
            code: 'ZIP_DUPLICATE_ENTRY',
            severity: 'error',
            message: `Duplicate entry name: ${existingName} vs ${entry.name}`,
            entryName: entry.name,
            details: { collisionKind: 'duplicate', otherName: existingName, key: targetName }
          });
          throw new ZipError(
            'ZIP_NAME_COLLISION',
            'Name collision detected (duplicate). Rename entries to avoid collisions.',
            {
              entryName: entry.name,
              context: buildCollisionContext('duplicate', existingName, entry.name, targetName, 'zip')
            }
          );
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
          targetName = resolveConflictName(targetName, nameIndex, caseIndex);
          renamed = true;
        }
      }

      const nfcName = targetName.normalize('NFC');
      const existingNfc = nfcIndex.get(nfcName);
      if (existingNfc && existingNfc.target !== targetName) {
        params.addIssue({
          code: 'ZIP_UNICODE_COLLISION',
          severity: 'error',
          message: `Unicode normalization collision: ${existingNfc.original} vs ${entry.name}`,
          entryName: entry.name,
          details: { collisionKind: 'unicode_nfc', otherName: existingNfc.original, key: nfcName }
        });
        throw new ZipError(
          'ZIP_NAME_COLLISION',
          'Name collision detected (unicode_nfc). Rename entries to avoid collisions.',
          {
            entryName: entry.name,
            context: buildCollisionContext('unicode_nfc', existingNfc.original, entry.name, nfcName, 'zip')
          }
        );
      }

      const caseKey = toCollisionKey(targetName, entry.isDirectory);
      const existingCase = caseIndex.get(caseKey);
      if (existingCase && existingCase.target !== targetName) {
        if (params.onCaseCollision === 'error') {
          params.addIssue({
            code: 'ZIP_CASE_COLLISION',
            severity: 'error',
            message: `Case-insensitive name collision: ${existingCase.original} vs ${entry.name}`,
            entryName: entry.name,
            details: { collisionKind: 'casefold', otherName: existingCase.original, key: caseKey }
          });
          throw new ZipError(
            'ZIP_NAME_COLLISION',
            'Name collision detected (case). Rename entries to avoid collisions.',
            {
              entryName: entry.name,
              context: buildCollisionContext('case', existingCase.original, entry.name, caseKey, 'zip')
            }
          );
        }
        if (params.onCaseCollision === 'last-wins') {
          const previous = nameIndex.get(existingCase.target);
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
          targetName = resolveConflictName(targetName, nameIndex, caseIndex);
          renamed = true;
        }
      }

      nameIndex.set(targetName, entries.length);
      originalNames.set(targetName, entry.name);
      const finalNfc = targetName.normalize('NFC');
      nfcIndex.set(finalNfc, { original: entry.name, target: targetName });
    caseIndex.set(toCollisionKey(targetName, entry.isDirectory), {
      original: entry.name,
      target: targetName,
      nfc: finalNfc
    });

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
  lowerIndex: Map<string, unknown>
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
    const caseKey = toCollisionKey(candidate, trailingSlash);
    if (!nameIndex.has(candidate) && !lowerIndex.has(caseKey)) {
      return candidate;
    }
    counter += 1;
  }
}

function buildCollisionContext(
  collisionType: 'duplicate' | 'case' | 'unicode_nfc',
  nameA: string,
  nameB: string,
  key: string,
  format: 'zip',
  collisionKind: 'duplicate' | 'casefold' | 'unicode_nfc' = collisionType === 'case' ? 'casefold' : collisionType
): Record<string, string> {
  return {
    collisionType,
    collisionKind,
    nameA,
    nameB,
    key,
    format
  };
}

async function spoolCompressedEntryToMemory(options: {
  source: ReadableStream<Uint8Array>;
  method: number;
  entryName: string;
  signal?: AbortSignal;
  progress?: ZipProgressOptions;
}): Promise<{ data: Uint8Array; compressedSize: bigint; uncompressedSize: bigint; crc32: number }> {
  const codec = getCompressionCodec(options.method);
  if (!codec || !codec.createCompressStream) {
    throw new ZipError('ZIP_UNSUPPORTED_METHOD', `Unsupported compression method ${options.method}`, {
      entryName: options.entryName,
      method: options.method
    });
  }
  const crcResult = { crc32: 0, bytes: 0n };
  const compressTracker = createProgressTracker(options.progress, {
    kind: 'compress',
    entryName: options.entryName
  });
  let stream = options.source;
  stream = stream.pipeThrough(createCrcTransform(crcResult, { strict: true }));
  stream = stream.pipeThrough(createProgressTransform(compressTracker));
  const transform = await codec.createCompressStream();
  stream = stream.pipeThrough(transform);
  const readOptions: { signal?: AbortSignal } = {};
  if (options.signal) readOptions.signal = options.signal;
  const data = await readAllBytes(stream, readOptions);

  return {
    data,
    compressedSize: BigInt(data.length),
    uncompressedSize: crcResult.bytes,
    crc32: crcResult.crc32
  };
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
  const sanitizedIssues = issues.map((issue) => ({
    ...issue,
    ...(issue.details ? { details: sanitizeDetails(issue.details) as Record<string, unknown> } : {})
  }));
  const report = {
    schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
    ok: summary.errors === 0,
    summary,
    issues: sanitizedIssues
  } as ZipNormalizeReport & { toJSON: () => unknown };
  report.toJSON = () => ({
    schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
    ok: report.ok,
    summary: report.summary,
    issues: sanitizedIssues.map(issueToJson)
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
  const strict = options?.isStrict ?? strictDefault;
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

/** @internal */
export function __getZipDefaultsForProfile(profile: ZipProfile): Required<ZipLimits> {
  return resolveProfileDefaults(profile).limits;
}

function normalizeLimits(limits?: ZipLimits, defaults: Required<ZipLimits> = DEFAULT_LIMITS): Required<ZipLimits> {
  const maxTotal =
    toBigInt(limits?.maxTotalDecompressedBytes ?? limits?.maxTotalUncompressedBytes) ??
    defaults.maxTotalUncompressedBytes;
  return {
    maxEntries: limits?.maxEntries ?? defaults.maxEntries,
    maxUncompressedEntryBytes: toBigInt(limits?.maxUncompressedEntryBytes) ?? defaults.maxUncompressedEntryBytes,
    maxTotalUncompressedBytes: maxTotal,
    maxTotalDecompressedBytes: maxTotal,
    maxCompressionRatio: limits?.maxCompressionRatio ?? defaults.maxCompressionRatio,
    maxDictionaryBytes: toBigInt(limits?.maxDictionaryBytes) ?? defaults.maxDictionaryBytes,
    maxXzDictionaryBytes:
      toBigInt(limits?.maxXzDictionaryBytes ?? limits?.maxDictionaryBytes) ?? defaults.maxXzDictionaryBytes,
    maxXzBufferedBytes:
      typeof limits?.maxXzBufferedBytes === 'number' && Number.isFinite(limits.maxXzBufferedBytes)
        ? Math.max(1, Math.floor(limits.maxXzBufferedBytes))
        : defaults.maxXzBufferedBytes,
    maxXzIndexRecords:
      typeof limits?.maxXzIndexRecords === 'number' && Number.isFinite(limits.maxXzIndexRecords)
        ? Math.max(1, Math.floor(limits.maxXzIndexRecords))
        : defaults.maxXzIndexRecords,
    maxXzIndexBytes:
      typeof limits?.maxXzIndexBytes === 'number' && Number.isFinite(limits.maxXzIndexBytes)
        ? Math.max(8, Math.floor(limits.maxXzIndexBytes))
        : defaults.maxXzIndexBytes,
    maxXzPreflightBlockHeaders:
      typeof limits?.maxXzPreflightBlockHeaders === 'number' && Number.isFinite(limits.maxXzPreflightBlockHeaders)
        ? Math.max(0, Math.floor(limits.maxXzPreflightBlockHeaders))
        : defaults.maxXzPreflightBlockHeaders,
    maxZipCentralDirectoryBytes:
      typeof limits?.maxZipCentralDirectoryBytes === 'number' && Number.isFinite(limits.maxZipCentralDirectoryBytes)
        ? Math.max(0, Math.floor(limits.maxZipCentralDirectoryBytes))
        : defaults.maxZipCentralDirectoryBytes,
    maxZipCommentBytes:
      typeof limits?.maxZipCommentBytes === 'number' && Number.isFinite(limits.maxZipCommentBytes)
        ? Math.max(0, Math.floor(limits.maxZipCommentBytes))
        : defaults.maxZipCommentBytes,
    maxZipEocdSearchBytes:
      typeof limits?.maxZipEocdSearchBytes === 'number' && Number.isFinite(limits.maxZipEocdSearchBytes)
        ? Math.max(22, Math.floor(limits.maxZipEocdSearchBytes))
        : defaults.maxZipEocdSearchBytes,
    maxBzip2BlockSize:
      typeof limits?.maxBzip2BlockSize === 'number' && Number.isFinite(limits.maxBzip2BlockSize)
        ? Math.max(1, Math.min(9, Math.floor(limits.maxBzip2BlockSize)))
        : defaults.maxBzip2BlockSize,
    maxInputBytes: toBigInt(limits?.maxInputBytes) ?? defaults.maxInputBytes
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
      ...(err.offset !== undefined ? { offset: err.offset.toString() } : {}),
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
  const sanitizedIssues = issues.map((issue) => ({
    ...issue,
    ...(issue.details ? { details: sanitizeDetails(issue.details) as Record<string, unknown> } : {})
  }));
  const report = {
    schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
    ok: summary.errors === 0,
    summary,
    issues: sanitizedIssues
  } as ZipAuditReport & { toJSON: () => unknown };
  report.toJSON = () => ({
    schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
    ok: report.ok,
    summary: report.summary,
    issues: sanitizedIssues.map(issueToJson)
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
