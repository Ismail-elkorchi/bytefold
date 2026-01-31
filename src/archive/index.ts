import { ArchiveError } from './errors.js';
import type {
  ArchiveAuditReport,
  ArchiveEntry,
  ArchiveFormat,
  ArchiveLimits,
  ArchiveNormalizeReport,
  ArchiveOpenOptions,
  ArchiveProfile
} from './types.js';
import { readAllBytes } from '../streams/buffer.js';
import { readableFromBytes } from '../streams/web.js';
import { createDecompressTransform } from '../compression/streams.js';
import { ZipReader } from '../reader/ZipReader.js';
import { ZipWriter } from '../writer/ZipWriter.js';
import type {
  ZipAuditOptions,
  ZipAuditReport,
  ZipProfile,
  ZipReaderOptions,
  ZipReaderOpenOptions,
  ZipWriterOptions
} from '../types.js';
import { TarReader } from '../tar/TarReader.js';
import { TarWriter } from '../tar/TarWriter.js';
import type { TarAuditOptions, TarNormalizeOptions, TarReaderOptions, TarWriterOptions } from '../tar/types.js';

export interface ArchiveReader {
  format: ArchiveFormat;
  entries(): AsyncGenerator<ArchiveEntry>;
  audit(options?: ArchiveAuditOptions): Promise<ArchiveAuditReport>;
  assertSafe(options?: ArchiveAuditOptions): Promise<void>;
  normalizeToWritable?(writable: WritableStream<Uint8Array>, options?: ArchiveNormalizeOptions): Promise<ArchiveNormalizeReport>;
}

export interface ArchiveWriter {
  format: 'zip' | 'tar';
  add(
    name: string,
    source?: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    options?: unknown
  ): Promise<void>;
  close(): Promise<void>;
}

export interface ArchiveWriterOptions {
  zip?: ZipWriterOptions;
  tar?: TarWriterOptions;
}

export interface ArchiveAuditOptions {
  profile?: ArchiveProfile;
  strict?: boolean;
  limits?: ArchiveLimits;
  signal?: AbortSignal;
}

export interface ArchiveNormalizeOptions {
  deterministic?: boolean;
  signal?: AbortSignal;
}

type ArchiveInput = Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;

export async function openArchive(input: ArchiveInput, options?: ArchiveOpenOptions): Promise<ArchiveReader> {
  const data = await resolveInput(input, options);
  const format = options?.format ?? 'auto';

  if (format !== 'auto') {
    return openWithFormat(format, data, options);
  }

  const detected = detectFormat(data);
  if (!detected) {
    throw new ArchiveError('ARCHIVE_UNSUPPORTED_FORMAT', 'Unable to detect archive format');
  }
  return openWithFormat(detected, data, options);
}

export function createArchiveWriter(
  format: 'zip' | 'tar',
  writable: WritableStream<Uint8Array>,
  options?: ArchiveWriterOptions
): ArchiveWriter {
  if (format === 'zip') {
    const writer = ZipWriter.toWritable(writable, options?.zip);
    return {
      format: 'zip',
      add: (name, source, addOptions) => writer.add(name, source as any, addOptions as any),
      close: () => writer.close()
    };
  }
  const writer = TarWriter.toWritable(writable, options?.tar);
  return {
    format: 'tar',
    add: (name, source, addOptions) => writer.add(name, source as any, addOptions as any),
    close: () => writer.close()
  };
}

async function openWithFormat(
  format: ArchiveFormat,
  data: Uint8Array,
  options?: ArchiveOpenOptions
): Promise<ArchiveReader> {
  if (format === 'zip') {
    const zipOptions: ZipReaderOptions = { ...(options?.zip ?? {}) };
    const profile = options?.profile;
    if (profile !== undefined) zipOptions.profile = profile as ZipProfile;
    if (options?.strict !== undefined) zipOptions.strict = options.strict;
    if (options?.limits !== undefined) zipOptions.limits = options.limits;
    if (options?.password !== undefined) zipOptions.password = options.password;
    const reader = await ZipReader.fromUint8Array(data, zipOptions);
    const openOptions: ZipReaderOpenOptions = {
      ...(options?.strict !== undefined ? { strict: options.strict } : {}),
      ...(options?.password !== undefined ? { password: options.password } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    return new ZipArchiveReader(reader, Object.keys(openOptions).length > 0 ? openOptions : undefined);
  }
  if (format === 'tar') {
    const tarOptions: TarReaderOptions = { ...(options?.tar ?? {}) };
    if (options?.profile !== undefined) tarOptions.profile = options.profile;
    if (options?.strict !== undefined) tarOptions.strict = options.strict;
    if (options?.limits !== undefined) tarOptions.limits = options.limits;
    const reader = await TarReader.fromUint8Array(data, tarOptions);
    const auditDefaults: TarAuditOptions = {
      ...(options?.profile !== undefined ? { profile: options.profile } : {}),
      ...(options?.strict !== undefined ? { strict: options.strict } : {}),
      ...(options?.limits !== undefined ? { limits: options.limits } : {})
    };
    return new TarArchiveReader(reader, Object.keys(auditDefaults).length > 0 ? auditDefaults : undefined, 'tar');
  }
  if (format === 'gz' || format === 'tgz') {
    const header = parseGzipHeader(data);
    const decompressed = await gunzipToBytes(data, options);
    if (format === 'tgz' || detectFormat(decompressed) === 'tar') {
      const tarOptions: TarReaderOptions = {
        ...(options?.profile !== undefined ? { profile: options.profile } : {}),
        ...(options?.strict !== undefined ? { strict: options.strict } : {}),
        ...(options?.limits !== undefined ? { limits: options.limits } : {})
      };
      const tarReader = await TarReader.fromUint8Array(decompressed, tarOptions);
      const auditDefaults: TarAuditOptions = { ...tarOptions };
      return new TarArchiveReader(
        tarReader,
        Object.keys(auditDefaults).length > 0 ? auditDefaults : undefined,
        'tgz'
      );
    }
    return new GzipArchiveReader(decompressed, header);
  }

  throw new ArchiveError('ARCHIVE_UNSUPPORTED_FORMAT', `Unsupported format: ${format}`);
}

async function resolveInput(input: ArchiveInput, options?: ArchiveOpenOptions): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  const readOptions: { signal?: AbortSignal; maxBytes?: bigint | number } = {};
  if (options?.signal) readOptions.signal = options.signal;
  if (options?.limits?.maxTotalUncompressedBytes !== undefined) {
    readOptions.maxBytes = options.limits.maxTotalUncompressedBytes;
  }
  return readAllBytes(input, readOptions);
}

function detectFormat(data: Uint8Array): ArchiveFormat | undefined {
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    return 'gz';
  }
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b) {
    const sig = ((data[2] ?? 0) << 8) | (data[3] ?? 0);
    if (sig === 0x0304 || sig === 0x0506 || sig === 0x0708) {
      return 'zip';
    }
  }
  if (data.length >= 512 && isTarHeader(data.subarray(0, 512))) {
    return 'tar';
  }
  return undefined;
}

function isTarHeader(block: Uint8Array): boolean {
  const checksumStored = parseOctal(block.subarray(148, 156));
  const checksumActual = computeChecksum(block);
  if (checksumStored !== undefined && checksumStored !== checksumActual) return false;
  const magic = readString(block, 257, 6);
  return magic === 'ustar' || magic === 'ustar\0' || magic === '';
}

function readString(buffer: Uint8Array, start: number, length: number): string {
  let end = start;
  for (; end < start + length; end += 1) {
    if (buffer[end] === 0) break;
  }
  return new TextDecoder('utf-8').decode(buffer.subarray(start, end)).trim();
}

function parseOctal(buffer: Uint8Array): number | undefined {
  const text = new TextDecoder('utf-8').decode(buffer).replace(/\0.*$/, '').trim();
  if (!text) return undefined;
  const value = parseInt(text, 8);
  return Number.isFinite(value) ? value : undefined;
}

function computeChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < header.length; i += 1) {
    if (i >= 148 && i < 156) sum += 0x20;
    else sum += header[i]!;
  }
  return sum;
}

async function gunzipToBytes(data: Uint8Array, options?: ArchiveOpenOptions): Promise<Uint8Array> {
  const transform = await createDecompressTransform({
    algorithm: 'gzip',
    ...(options?.signal ? { signal: options.signal } : {})
  });
  const stream = readableFromBytes(data).pipeThrough(transform);
  const readOptions: { signal?: AbortSignal; maxBytes?: bigint | number } = {};
  if (options?.signal) readOptions.signal = options.signal;
  if (options?.limits?.maxTotalUncompressedBytes !== undefined) {
    readOptions.maxBytes = options.limits.maxTotalUncompressedBytes;
  }
  return readAllBytes(stream, readOptions);
}

type GzipHeader = { name?: string; mtime?: Date };

function parseGzipHeader(data: Uint8Array): GzipHeader {
  if (data.length < 10) return {};
  const flags = data[3]!;
  const mtime = readUint32LE(data, 4);
  let offset = 10;
  if (flags & 0x04) {
    if (offset + 2 > data.length) return {};
    const xlen = data[offset]! | (data[offset + 1]! << 8);
    offset += 2 + xlen;
  }
  let name: string | undefined;
  if (flags & 0x08) {
    const start = offset;
    while (offset < data.length && data[offset] !== 0) offset += 1;
    name = decodeLatin1(data.subarray(start, offset));
    offset += 1;
  }
  if (flags & 0x10) {
    while (offset < data.length && data[offset] !== 0) offset += 1;
    offset += 1;
  }
  const header: GzipHeader = {};
  if (name !== undefined) header.name = name;
  if (mtime) header.mtime = new Date(mtime * 1000);
  return header;
}

function decodeLatin1(bytes: Uint8Array): string {
  try {
    return new TextDecoder('latin1').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function readUint32LE(data: Uint8Array, offset: number): number {
  return (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
}

class ZipArchiveReader implements ArchiveReader {
  format: ArchiveFormat = 'zip';
  constructor(private readonly reader: ZipReader, private readonly openOptions?: ZipReaderOpenOptions) {}

  async *entries(): AsyncGenerator<ArchiveEntry> {
    for await (const entry of this.reader.iterEntries()) {
      yield {
        format: 'zip',
        name: entry.name,
        size: entry.uncompressedSize,
        isDirectory: entry.isDirectory,
        isSymlink: entry.isSymlink,
        mtime: entry.mtime,
        open: () => this.reader.open(entry, this.openOptions),
        raw: entry
      };
    }
  }

  async audit(options?: ArchiveAuditOptions): Promise<ArchiveAuditReport> {
    const profile = options?.profile;
    const zipOptions: ZipAuditOptions = {
      ...(profile !== undefined ? { profile: profile as ZipProfile } : {}),
      ...(options?.strict !== undefined ? { strict: options.strict } : {}),
      ...(options?.limits !== undefined ? { limits: options.limits } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    const report = await this.reader.audit(zipOptions);
    const archiveReport: ArchiveAuditReport = {
      ok: report.ok,
      summary: {
        entries: report.summary.entries,
        warnings: report.summary.warnings,
        errors: report.summary.errors,
        ...(report.summary.trailingBytes !== undefined ? { totalBytes: report.summary.trailingBytes } : {})
      },
      issues: report.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        ...(issue.entryName ? { entryName: issue.entryName } : {}),
        ...(issue.offset !== undefined ? { offset: issue.offset } : {}),
        ...(issue.details ? { details: issue.details } : {})
      }))
    };
    const reportJson = (report as ZipAuditReport & { toJSON?: () => unknown }).toJSON;
    if (reportJson) archiveReport.toJSON = reportJson;
    return archiveReport;
  }

  async assertSafe(options?: ArchiveAuditOptions): Promise<void> {
    const profile = options?.profile;
    const auditOptions: ZipAuditOptions = {
      ...(profile !== undefined ? { profile: profile as ZipProfile } : {}),
      ...(options?.strict !== undefined ? { strict: options.strict } : {}),
      ...(options?.limits !== undefined ? { limits: options.limits } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    await this.reader.assertSafe(auditOptions);
  }

  async normalizeToWritable(
    writable: WritableStream<Uint8Array>,
    options?: ArchiveNormalizeOptions
  ): Promise<ArchiveNormalizeReport> {
    const normalizeOptions = {
      ...(options?.deterministic !== undefined ? { deterministic: options.deterministic } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    const report = await this.reader.normalizeToWritable(writable, normalizeOptions);
    const archiveReport: ArchiveNormalizeReport = {
      ok: report.ok,
      summary: {
        entries: report.summary.entries,
        outputEntries: report.summary.outputEntries,
        droppedEntries: report.summary.droppedEntries,
        renamedEntries: report.summary.renamedEntries,
        warnings: report.summary.warnings,
        errors: report.summary.errors
      },
      issues: report.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        ...(issue.entryName ? { entryName: issue.entryName } : {}),
        ...(issue.offset !== undefined ? { offset: issue.offset } : {}),
        ...(issue.details ? { details: issue.details } : {})
      }))
    };
    if (report.toJSON) archiveReport.toJSON = report.toJSON;
    return archiveReport;
  }
}

class TarArchiveReader implements ArchiveReader {
  constructor(
    private readonly reader: TarReader,
    private readonly auditDefaults?: TarAuditOptions,
    public format: ArchiveFormat = 'tar'
  ) {}

  async *entries(): AsyncGenerator<ArchiveEntry> {
    for await (const entry of this.reader.iterEntries()) {
      const archiveEntry: ArchiveEntry = {
        format: this.format,
        name: entry.name,
        size: entry.size,
        isDirectory: entry.isDirectory,
        isSymlink: entry.isSymlink,
        open: () => this.reader.open(entry),
        raw: entry
      };
      if (entry.mtime) archiveEntry.mtime = entry.mtime;
      if (entry.mode !== undefined) archiveEntry.mode = entry.mode;
      if (entry.uid !== undefined) archiveEntry.uid = entry.uid;
      if (entry.gid !== undefined) archiveEntry.gid = entry.gid;
      if (entry.linkName !== undefined) archiveEntry.linkName = entry.linkName;
      yield archiveEntry;
    }
  }

  async audit(options?: ArchiveAuditOptions): Promise<ArchiveAuditReport> {
    const profile = options?.profile ?? this.auditDefaults?.profile;
    const strict = options?.strict ?? this.auditDefaults?.strict;
    const limits = options?.limits ?? this.auditDefaults?.limits;
    const tarOptions: TarAuditOptions = {
      ...(profile !== undefined ? { profile } : {}),
      ...(strict !== undefined ? { strict } : {}),
      ...(limits !== undefined ? { limits } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    const report = await this.reader.audit(tarOptions);
    return report;
  }

  async assertSafe(options?: ArchiveAuditOptions): Promise<void> {
    const profile = options?.profile ?? this.auditDefaults?.profile;
    const strict = options?.strict ?? this.auditDefaults?.strict;
    const limits = options?.limits ?? this.auditDefaults?.limits;
    const tarOptions: TarAuditOptions = {
      ...(profile !== undefined ? { profile } : {}),
      ...(strict !== undefined ? { strict } : {}),
      ...(limits !== undefined ? { limits } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    await this.reader.assertSafe(tarOptions);
  }

  async normalizeToWritable(
    writable: WritableStream<Uint8Array>,
    options?: ArchiveNormalizeOptions
  ): Promise<ArchiveNormalizeReport> {
    const tarOptions: TarNormalizeOptions = {
      ...(options?.deterministic !== undefined ? { deterministic: options.deterministic } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    };
    return this.reader.normalizeToWritable(writable, tarOptions);
  }
}

class GzipArchiveReader implements ArchiveReader {
  format: ArchiveFormat = 'gz';
  private readonly entry: ArchiveEntry;

  constructor(private readonly data: Uint8Array, header: GzipHeader) {
    const entry: ArchiveEntry = {
      format: 'gz',
      name: header.name ?? 'data',
      size: BigInt(data.length),
      isDirectory: false,
      isSymlink: false,
      open: async () => readableFromBytes(this.data)
    };
    if (header.mtime) entry.mtime = header.mtime;
    this.entry = entry;
  }

  async *entries(): AsyncGenerator<ArchiveEntry> {
    yield this.entry;
  }

  async audit(options?: ArchiveAuditOptions): Promise<ArchiveAuditReport> {
    const issues: ArchiveAuditReport['issues'] = [];
    const summary: ArchiveAuditReport['summary'] = {
      entries: 1,
      warnings: 0,
      errors: 0
    };
    const totalBytes = this.entry.size > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(this.entry.size);
    if (totalBytes !== undefined) summary.totalBytes = totalBytes;
    if (options?.limits?.maxTotalUncompressedBytes && this.entry.size > BigInt(options.limits.maxTotalUncompressedBytes)) {
      issues.push({
        code: 'GZIP_LIMIT_EXCEEDED',
        severity: 'error',
        message: 'Uncompressed size exceeds limit',
        entryName: this.entry.name
      });
      summary.errors += 1;
    }
    const pathIssues = entryPathIssues(this.entry.name);
    for (const issue of pathIssues) {
      issues.push(issue);
      if (issue.severity === 'warning') summary.warnings += 1;
      if (issue.severity === 'error') summary.errors += 1;
    }
    return {
      ok: summary.errors === 0,
      summary,
      issues,
      toJSON: () => ({ ok: summary.errors === 0, summary, issues })
    };
  }

  async assertSafe(options?: ArchiveAuditOptions): Promise<void> {
    const report = await this.audit(options);
    if (!report.ok) {
      throw new ArchiveError('ARCHIVE_AUDIT_FAILED', 'GZIP audit failed');
    }
  }
}

function entryPathIssues(entryName: string): ArchiveAuditReport['issues'] {
  const issues: ArchiveAuditReport['issues'] = [];
  if (entryName.includes('\u0000')) {
    issues.push({
      code: 'ARCHIVE_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Entry name contains NUL byte',
      entryName
    });
    return issues;
  }
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    issues.push({
      code: 'ARCHIVE_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Absolute paths are not allowed',
      entryName
    });
  }
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.some((part) => part === '..')) {
    issues.push({
      code: 'ARCHIVE_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Path traversal detected',
      entryName
    });
  }
  return issues;
}
