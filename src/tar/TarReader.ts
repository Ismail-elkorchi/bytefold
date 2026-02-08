import { ArchiveError } from '../archive/errors.js';
import { normalizePathForCollision, toCollisionKey } from '../text/caseFold.js';
import type { ArchiveLimits, ArchiveProfile } from '../archive/types.js';
import { readAllBytes } from '../streams/buffer.js';
import { readableFromBytes } from '../streams/web.js';
import { BYTEFOLD_REPORT_SCHEMA_VERSION } from '../reportSchema.js';
import { AGENT_RESOURCE_LIMITS, DEFAULT_RESOURCE_LIMITS } from '../limits.js';
import type {
  TarAuditOptions,
  TarAuditReport,
  TarEntry,
  TarIssue,
  TarNormalizeOptions,
  TarNormalizeReport,
  TarReaderOptions
} from './types.js';
import { TarWriter } from './TarWriter.js';
import { throwIfAborted } from '../abort.js';
import { decodeNullTerminatedUtf8 } from '../binary.js';

const BLOCK_SIZE = 512;

const DEFAULT_LIMITS: Required<ArchiveLimits> = DEFAULT_RESOURCE_LIMITS;
const AGENT_LIMITS: Required<ArchiveLimits> = AGENT_RESOURCE_LIMITS;

const TEXT_DECODER = new TextDecoder('utf-8');

type TarEntryRecord = TarEntry & {
  dataOffset: number;
  dataSize: bigint;
};

/** Read TAR archives from bytes, streams, or URLs. */
export class TarReader {
  private readonly profile: ArchiveProfile;
  private readonly strict: boolean;
  private readonly limits: Required<ArchiveLimits>;
  private readonly warningsList: TarIssue[] = [];
  private entriesList: TarEntryRecord[] | null = null;
  private readonly storeEntries: boolean;
  private readonly signal: AbortSignal | undefined;

  private constructor(
    private readonly data: Uint8Array,
    options?: TarReaderOptions
  ) {
    const resolved = resolveReaderProfile(options);
    this.profile = resolved.profile;
    this.strict = resolved.strict;
    this.limits = resolved.limits;
    this.storeEntries = options?.shouldStoreEntries ?? true;
    this.signal = options?.signal;
  }

  /** Create a reader from in-memory bytes. */
  static async fromUint8Array(data: Uint8Array, options?: TarReaderOptions): Promise<TarReader> {
    const reader = new TarReader(data, options);
    await reader.init();
    return reader;
  }

  /** Create a reader from a readable stream. */
  static async fromStream(stream: ReadableStream<Uint8Array>, options?: TarReaderOptions): Promise<TarReader> {
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
    return TarReader.fromUint8Array(data, options);
  }

  /** Create a reader from a URL via fetch(). */
  static async fromUrl(url: string | URL, options?: TarReaderOptions): Promise<TarReader> {
    const response = await fetch(typeof url === 'string' ? url : url.toString(), {
      signal: options?.signal ?? null
    });
    if (!response.ok) {
      throw new ArchiveError('ARCHIVE_BAD_HEADER', `Unexpected HTTP status ${response.status}`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    return TarReader.fromUint8Array(data, options);
  }

  /** Return stored entries (requires shouldStoreEntries=true). */
  entries(): TarEntry[] {
    if (!this.storeEntries) {
      throw new ArchiveError('ARCHIVE_UNSUPPORTED_FEATURE', 'Entries are not stored; use iterEntries()');
    }
    if (!this.entriesList) return [];
    return this.entriesList.map((entry) => ({ ...entry }));
  }

  /** Return non-fatal warnings encountered during parsing. */
  warnings(): TarIssue[] {
    return [...this.warningsList];
  }

  /** Iterate entries (from cached entries). */
  async *iterEntries(): AsyncGenerator<TarEntry> {
    if (!this.entriesList) return;
    for (const entry of this.entriesList) {
      yield { ...entry };
    }
  }

  /** Open a stream for a specific entry's contents. */
  async open(entry: TarEntry): Promise<ReadableStream<Uint8Array>> {
    if (!this.entriesList) throw new ArchiveError('ARCHIVE_UNSUPPORTED_FEATURE', 'Entries not loaded');
    const record = this.entriesList.find((item) => item.name === entry.name && item.size === entry.size);
    if (!record) {
      throw new ArchiveError('ARCHIVE_UNSUPPORTED_FEATURE', 'Entry not found');
    }
    const start = record.dataOffset;
    const end = start + Number(record.dataSize);
    const slice = this.data.subarray(start, end);
    return readableFromBytes(slice);
  }

  /** Audit the archive and return a report of issues. */
  async audit(options?: TarAuditOptions): Promise<TarAuditReport> {
    const settings = this.resolveAuditSettings(options);
    const issues: TarIssue[] = [];
    const summary: TarAuditReport['summary'] = {
      entries: 0,
      warnings: 0,
      errors: 0
    };

    const addIssue = (issue: TarIssue) => {
      issues.push(issue);
      if (issue.severity === 'warning') summary.warnings += 1;
      if (issue.severity === 'error') summary.errors += 1;
    };

    if (!this.entriesList) {
      addIssue({
        code: 'TAR_PARSE_FAILED',
        severity: 'error',
        message: 'Entries not loaded'
      });
      return finalizeAuditReport(issues, summary);
    }

    const seenNames = new Map<string, string>();
    const seenNfc = new Map<string, { original: string; normalized: string }>();
    const seenCase = new Map<string, { original: string; nfc: string }>();
    let total = 0n;

    for (const entry of this.entriesList) {
      summary.entries += 1;
      const pathIssues = entryPathIssues(entry.name);
      for (const issue of pathIssues) {
        addIssue(issue);
      }

      total += entry.size;
      if (total > settings.limits.maxTotalUncompressedBytes) {
        addIssue({
          code: 'TAR_LIMIT_EXCEEDED',
          severity: 'error',
          message: 'Total uncompressed size exceeds limit'
        });
      }
      if (entry.size > settings.limits.maxUncompressedEntryBytes) {
        addIssue({
          code: 'TAR_LIMIT_EXCEEDED',
          severity: 'error',
          message: 'Entry uncompressed size exceeds limit',
          entryName: entry.name
        });
      }

      const normalizedName = normalizePathForCollision(entry.name, entry.isDirectory);
      if (normalizedName) {
        const existing = seenNames.get(normalizedName);
        if (existing !== undefined) {
          addIssue({
            code: 'TAR_DUPLICATE_ENTRY',
            severity: settings.strict ? 'error' : 'warning',
            message: `Duplicate entry name: ${existing} vs ${entry.name}`,
            entryName: entry.name,
            details: { otherName: existing, key: normalizedName, collisionKind: 'duplicate' }
          });
        } else {
          const nfcName = normalizedName.normalize('NFC');
          const caseKey = toCollisionKey(normalizedName, entry.isDirectory);
          const existingNfc = seenNfc.get(nfcName);
          if (existingNfc && existingNfc.normalized !== normalizedName) {
            addIssue({
              code: 'TAR_UNICODE_COLLISION',
              severity: 'error',
              message: `Unicode normalization collision: ${existingNfc.original} vs ${entry.name}`,
              entryName: entry.name,
              details: { otherName: existingNfc.original, key: nfcName, collisionKind: 'unicode_nfc' }
            });
          } else {
            const existingCase = seenCase.get(caseKey);
            if (existingCase && existingCase.nfc !== nfcName) {
              addIssue({
                code: 'TAR_CASE_COLLISION',
                severity: settings.strict ? 'error' : 'warning',
                message: `Case-insensitive name collision: ${existingCase.original} vs ${entry.name}`,
                entryName: entry.name,
                details: { otherName: existingCase.original, key: caseKey, collisionKind: 'casefold' }
              });
            }
          }
          seenNames.set(normalizedName, entry.name);
          seenNfc.set(nfcName, { original: entry.name, normalized: normalizedName });
          seenCase.set(caseKey, { original: entry.name, nfc: nfcName });
        }
      }

      if (entry.isSymlink && settings.symlinkSeverity !== 'info') {
        addIssue({
          code: 'TAR_SYMLINK_PRESENT',
          severity: settings.symlinkSeverity,
          message: 'Symlink entries are present',
          entryName: entry.name
        });
      }
    }

    const totalBytes = toSafeNumber(total);
    if (totalBytes !== undefined) summary.totalBytes = totalBytes;
    return finalizeAuditReport(issues, summary);
  }

  /** Audit and throw if the archive fails the selected profile. */
  async assertSafe(options?: TarAuditOptions): Promise<void> {
    const report = await this.audit(options);
    if (!report.ok) {
      throw new ArchiveError('ARCHIVE_AUDIT_FAILED', 'TAR audit failed');
    }
  }

  /** Normalize to a writable stream, producing a report. */
  async normalizeToWritable(
    writable: WritableStream<Uint8Array>,
    options?: TarNormalizeOptions
  ): Promise<TarNormalizeReport> {
    if (!this.entriesList) {
      throw new ArchiveError('ARCHIVE_UNSUPPORTED_FEATURE', 'Entries not loaded');
    }
    const signal = options?.signal ?? this.signal;
    const deterministic = options?.isDeterministic ?? true;
    const onDuplicate = options?.onDuplicate ?? 'error';
    const onCaseCollision = options?.onCaseCollision ?? 'error';
    const onSymlink = options?.onSymlink ?? 'error';
    const onUnsupported = options?.onUnsupported ?? 'error';

    const issues: TarIssue[] = [];
    const summary = {
      entries: 0,
      outputEntries: 0,
      droppedEntries: 0,
      renamedEntries: 0,
      warnings: 0,
      errors: 0
    };

    const addIssue = (issue: TarIssue) => {
      issues.push(issue);
      if (issue.severity === 'warning') summary.warnings += 1;
      if (issue.severity === 'error') summary.errors += 1;
    };

    const normalized = collectNormalizedEntries(this.entriesList, {
      deterministic,
      onDuplicate,
      onCaseCollision,
      onSymlink,
      addIssue,
      summary
    });

    const writerOptions = {
      ...(deterministic ? { isDeterministic: deterministic } : {}),
      ...(signal ? { signal } : {})
    };
    const writer = TarWriter.toWritable(writable, writerOptions);

    for (const item of normalized) {
      throwIfAborted(signal);
      summary.entries += 1;
      if (item.dropped) continue;
      const entry = item.entry;
      if (entry.isSymlink) {
        addIssue({
          code: 'TAR_SYMLINK_PRESENT',
          severity: 'error',
          message: 'Symlink entries are not allowed during normalization',
          entryName: entry.name
        });
        if (onSymlink === 'drop') {
          summary.droppedEntries += 1;
          continue;
        }
        throw new ArchiveError('ARCHIVE_UNSUPPORTED_FEATURE', 'Symlink entries are not allowed during normalization', {
          entryName: entry.name
        });
      }
      if (entry.type === 'link') {
        addIssue({
          code: 'TAR_UNSUPPORTED_ENTRY',
          severity: 'error',
          message: 'Hardlink entries are not allowed during normalization',
          entryName: entry.name
        });
        if (onUnsupported === 'drop') {
          summary.droppedEntries += 1;
          continue;
        }
        throw new ArchiveError('ARCHIVE_UNSUPPORTED_FEATURE', 'Hardlink entries are not allowed during normalization', {
          entryName: entry.name
        });
      }

      const data = entry.isDirectory
        ? new Uint8Array(0)
        : this.data.subarray(entry.dataOffset, entry.dataOffset + Number(entry.dataSize));
      const mtime = deterministic ? new Date(0) : entry.mtime;
      const mode = deterministic ? defaultMode(entry) : clampMode(entry.mode ?? defaultMode(entry));
      const addOptions = {
        type: entry.type,
        ...(mtime ? { mtime } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(entry.uid !== undefined ? { uid: deterministic ? 0 : entry.uid } : {}),
        ...(entry.gid !== undefined ? { gid: deterministic ? 0 : entry.gid } : {}),
        ...(entry.linkName !== undefined ? { linkName: entry.linkName } : {}),
        ...(entry.pax ? { pax: entry.pax } : {})
      };
      try {
        await writer.add(item.normalizedName, data, addOptions);
      } catch (err) {
        addIssue({
          code: 'TAR_UNSUPPORTED_ENTRY',
          severity: 'error',
          message: (err as Error).message,
          entryName: entry.name
        });
        if (onUnsupported === 'drop') {
          summary.droppedEntries += 1;
          continue;
        }
        throw err;
      }

      summary.outputEntries += 1;
    }

    await writer.close();
    return finalizeNormalizeReport(issues, summary);
  }

  /** @internal */
  private resolveAuditSettings(options?: TarAuditOptions): {
    profile: ArchiveProfile;
    strict: boolean;
    limits: Required<ArchiveLimits>;
    symlinkSeverity: 'info' | 'warning' | 'error';
  } {
    const profile = options?.profile ?? this.profile;
    const defaults = profile === this.profile ? { strict: this.strict, limits: this.limits } : resolveProfileDefaults(profile);
    const strict = options?.isStrict ?? defaults.strict;
    const limits = normalizeLimits(options?.limits, defaults.limits);
    return {
      profile,
      strict,
      limits,
      symlinkSeverity: profile === 'agent' ? 'error' : 'warning'
    };
  }

  /** @internal */
  private async init(): Promise<void> {
    const { entries, warnings } = parseTarEntries(this.data, {
      strict: this.strict,
      limits: this.limits
    });
    this.entriesList = entries;
    this.warningsList.push(...warnings);
  }
}

function resolveReaderProfile(options?: TarReaderOptions): {
  profile: ArchiveProfile;
  strict: boolean;
  limits: Required<ArchiveLimits>;
} {
  const profile = options?.profile ?? 'strict';
  const defaults = profile === 'agent' ? AGENT_LIMITS : DEFAULT_LIMITS;
  const strictDefault = profile === 'compat' ? false : true;
  const strict = options?.isStrict ?? strictDefault;
  const limits = normalizeLimits(options?.limits, defaults);
  return { profile, strict, limits };
}

function resolveProfileDefaults(profile: ArchiveProfile): { strict: boolean; limits: Required<ArchiveLimits> } {
  if (profile === 'compat') return { strict: false, limits: DEFAULT_LIMITS };
  if (profile === 'agent') return { strict: true, limits: AGENT_LIMITS };
  return { strict: true, limits: DEFAULT_LIMITS };
}

/** @internal */
export function __getTarDefaultsForProfile(profile: ArchiveProfile): Required<ArchiveLimits> {
  return resolveProfileDefaults(profile).limits;
}

function normalizeLimits(limits?: ArchiveLimits, defaults: Required<ArchiveLimits> = DEFAULT_LIMITS): Required<ArchiveLimits> {
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

function toBigInt(value?: bigint | number): bigint | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'bigint' ? value : BigInt(value);
}

function parseTarEntries(data: Uint8Array, options: { strict: boolean; limits: Required<ArchiveLimits> }): { entries: TarEntryRecord[]; warnings: TarIssue[] } {
  const entries: TarEntryRecord[] = [];
  const warnings: TarIssue[] = [];

  let offset = 0;
  let globalPax: Record<string, string> | null = null;
  let pendingPax: Record<string, string> | null = null;
  let entryCount = 0;
  let totalBytes = 0n;

  while (offset + BLOCK_SIZE <= data.length) {
    const header = data.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(header)) {
      const next = data.subarray(offset + BLOCK_SIZE, offset + BLOCK_SIZE * 2);
      if (next.length === BLOCK_SIZE && isZeroBlock(next)) {
        break;
      }
    }

    const checksumStored = parseOctal(header.subarray(148, 156));
    const checksumActual = computeChecksum(header);
    if (checksumStored !== undefined && Number(checksumStored) !== checksumActual) {
      const issue: TarIssue = {
        code: 'TAR_BAD_HEADER',
        severity: options.strict ? 'error' : 'warning',
        message: 'Header checksum mismatch',
        offset: BigInt(offset).toString()
      };
      if (options.strict) {
        throw new ArchiveError('ARCHIVE_BAD_HEADER', issue.message, { offset: BigInt(offset) });
      }
      warnings.push(issue);
    }

    const name = readString(header, 0, 100);
    const mode = parseNumeric(header.subarray(100, 108));
    const uid = parseNumeric(header.subarray(108, 116));
    const gid = parseNumeric(header.subarray(116, 124));
    let size = parseNumeric(header.subarray(124, 136));
    const mtime = parseNumeric(header.subarray(136, 148));
    const typeflag = readString(header, 156, 1) || '0';
    const linkName = readString(header, 157, 100);
    const prefix = readString(header, 345, 155);

    let fullName = prefix ? `${prefix}/${name}` : name;

    const blockSize = BigInt(BLOCK_SIZE);
    const dataOffset = offset + BLOCK_SIZE;
    const sizeBytes = size ?? 0n;
    const dataEnd = dataOffset + Number(sizeBytes);
    const padded = Number((sizeBytes + blockSize - 1n) / blockSize * blockSize);

    if (dataEnd > data.length) {
      throw new ArchiveError('ARCHIVE_TRUNCATED', 'TAR entry truncated', { offset: BigInt(offset) });
    }

    if (typeflag === 'x' || typeflag === 'g') {
      const paxData = data.subarray(dataOffset, dataOffset + Number(sizeBytes));
      const records = parsePaxRecords(paxData);
      if (typeflag === 'g') {
        globalPax = { ...(globalPax ?? {}), ...records };
        pendingPax = null;
      } else {
        pendingPax = { ...(globalPax ?? {}), ...records };
      }
      offset = dataOffset + padded;
      continue;
    }

    const pax = pendingPax ? { ...pendingPax } : globalPax ? { ...globalPax } : undefined;
    pendingPax = null;

    if (pax?.path) {
      fullName = pax.path;
    }

    let resolvedLink = linkName;
    if (pax?.linkpath) {
      resolvedLink = pax.linkpath;
    }

    if (pax?.size) {
      const parsedSize = parsePaxSize(pax.size);
      if (parsedSize !== undefined) {
        size = parsedSize;
      }
    }

    const entryType = typeFromFlag(typeflag);
    const entryMtime = pax?.mtime ? parseMtime(pax.mtime) : mtime !== undefined ? new Date(Number(mtime) * 1000) : undefined;

    const isDirectory = entryType === 'directory' || fullName.endsWith('/');
    const isSymlink = entryType === 'symlink';

    const entry: TarEntryRecord = {
      name: fullName,
      size: size ?? 0n,
      type: entryType,
      isDirectory,
      isSymlink,
      dataOffset,
      dataSize: size ?? 0n,
      ...(pax ? { pax } : {})
    };
    if (entryMtime) entry.mtime = entryMtime;
    if (mode !== undefined) entry.mode = Number(mode);
    if (uid !== undefined) entry.uid = Number(uid);
    if (gid !== undefined) entry.gid = Number(gid);
    if (resolvedLink) entry.linkName = resolvedLink;

    entries.push(entry);
    entryCount += 1;
    totalBytes += entry.size;

    if (entryCount > options.limits.maxEntries) {
      throw new ArchiveError('ARCHIVE_LIMIT_EXCEEDED', 'Too many TAR entries');
    }
    if (entry.size > options.limits.maxUncompressedEntryBytes) {
      throw new ArchiveError('ARCHIVE_LIMIT_EXCEEDED', 'TAR entry exceeds size limit', { entryName: entry.name });
    }
    if (totalBytes > options.limits.maxTotalUncompressedBytes) {
      throw new ArchiveError('ARCHIVE_LIMIT_EXCEEDED', 'TAR total size exceeds limit');
    }

    offset = dataOffset + padded;
  }

  return { entries, warnings };
}

function readString(buffer: Uint8Array, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  let end = slice.indexOf(0);
  if (end === -1) end = slice.length;
  return TEXT_DECODER.decode(slice.subarray(0, end)).trim();
}

function parseNumeric(buffer: Uint8Array): bigint | undefined {
  if (buffer.length === 0) return undefined;
  const first = buffer[0] ?? 0;
  if ((first & 0x80) !== 0) {
    return parseBase256(buffer);
  }
  return parseOctal(buffer);
}

function parseOctal(buffer: Uint8Array): bigint | undefined {
  const text = decodeNullTerminatedUtf8(buffer).trim();
  if (!text) return undefined;
  const value = parseInt(text, 8);
  if (!Number.isFinite(value)) return undefined;
  return BigInt(value);
}

function parseBase256(buffer: Uint8Array): bigint | undefined {
  let result = 0n;
  for (const byte of buffer) {
    result = (result << 8n) | BigInt(byte & 0xff);
  }
  // Clear the sign bit.
  const bits = BigInt(buffer.length * 8 - 1);
  const mask = (1n << bits) - 1n;
  return result & mask;
}

function parseMtime(value: string): Date | undefined {
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return new Date(num * 1000);
}

function parsePaxSize(value: string): bigint | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    if (trimmed.includes('.')) {
      const num = Number(trimmed);
      if (!Number.isFinite(num)) return undefined;
      return BigInt(Math.max(0, Math.floor(num)));
    }
    const parsed = BigInt(trimmed);
    return parsed < 0n ? 0n : parsed;
  } catch {
    return undefined;
  }
}

function computeChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < header.length; i += 1) {
    if (i >= 148 && i < 156) {
      sum += 0x20;
    } else {
      sum += header[i]!;
    }
  }
  return sum;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function typeFromFlag(flag: string): TarEntry['type'] {
  switch (flag) {
    case '0':
    case '\0':
      return 'file';
    case '1':
      return 'link';
    case '2':
      return 'symlink';
    case '3':
      return 'character';
    case '4':
      return 'block';
    case '5':
      return 'directory';
    case '6':
      return 'fifo';
    default:
      return 'unknown';
  }
}

function parsePaxRecords(buffer: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < buffer.length) {
    const spaceIndex = buffer.indexOf(0x20, offset);
    if (spaceIndex === -1) break;
    const lenText = TEXT_DECODER.decode(buffer.subarray(offset, spaceIndex));
    const length = parseInt(lenText, 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = TEXT_DECODER.decode(buffer.subarray(spaceIndex + 1, offset + length));
    const eqIndex = record.indexOf('=');
    if (eqIndex > 0) {
      const key = record.slice(0, eqIndex);
      const value = record.slice(eqIndex + 1).replace(/\n$/, '');
      out[key] = value;
    }
    offset += length;
  }
  return out;
}

function entryPathIssues(entryName: string): TarIssue[] {
  const issues: TarIssue[] = [];
  if (entryName.includes('\u0000')) {
    issues.push({
      code: 'TAR_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Entry name contains NUL byte',
      entryName
    });
    return issues;
  }
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    issues.push({
      code: 'TAR_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Absolute paths are not allowed in TAR entries',
      entryName
    });
  }
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.some((part) => part === '..')) {
    issues.push({
      code: 'TAR_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Path traversal detected in TAR entry',
      entryName
    });
  }
  return issues;
}

function collectNormalizedEntries(
  entries: TarEntryRecord[],
  params: {
    deterministic: boolean;
    onDuplicate: 'error' | 'last-wins' | 'rename';
    onCaseCollision: 'error' | 'last-wins' | 'rename';
    onSymlink: 'error' | 'drop';
    addIssue: (issue: TarIssue) => void;
    summary: {
      droppedEntries: number;
      renamedEntries: number;
    };
  }
): Array<{ entry: TarEntryRecord; normalizedName: string; dropped: boolean }> {
  const out: Array<{ entry: TarEntryRecord; normalizedName: string; dropped: boolean }> = [];
  const nameIndex = new Map<string, number>();
  const caseIndex = new Map<string, { original: string; target: string; nfc: string }>();
  const nfcIndex = new Map<string, { original: string; target: string }>();
  const originalNames = new Map<string, string>();

  for (const entry of entries) {
    const normalizedName = normalizeEntryName(entry.name, entry.isDirectory, params.addIssue);
    let targetName = normalizedName;
    let renamed = false;

    const existingIndex = nameIndex.get(targetName);
    if (existingIndex !== undefined) {
      if (params.onDuplicate === 'error') {
        const existingName = originalNames.get(targetName) ?? targetName;
        params.addIssue({
          code: 'TAR_DUPLICATE_ENTRY',
          severity: 'error',
          message: `Duplicate entry name: ${existingName} vs ${entry.name}`,
          entryName: entry.name,
          details: { collisionKind: 'duplicate', otherName: existingName, key: targetName }
        });
        throw new ArchiveError('ARCHIVE_NAME_COLLISION', 'Name collision detected (duplicate). Rename entries to avoid collisions.', {
          entryName: entry.name,
          context: buildCollisionContext('duplicate', existingName, entry.name, targetName, 'tar')
        });
      }
      if (params.onDuplicate === 'last-wins') {
        out[existingIndex]!.dropped = true;
        params.summary.droppedEntries += 1;
      } else if (params.onDuplicate === 'rename') {
        targetName = resolveConflictName(targetName, nameIndex, caseIndex);
        renamed = true;
      }
    }

    const nfcName = targetName.normalize('NFC');
    const existingNfc = nfcIndex.get(nfcName);
    if (existingNfc && existingNfc.target !== targetName) {
      params.addIssue({
        code: 'TAR_UNICODE_COLLISION',
        severity: 'error',
        message: `Unicode normalization collision: ${existingNfc.original} vs ${entry.name}`,
        entryName: entry.name,
        details: { collisionKind: 'unicode_nfc', otherName: existingNfc.original, key: nfcName }
      });
      throw new ArchiveError(
        'ARCHIVE_NAME_COLLISION',
        'Name collision detected (unicode_nfc). Rename entries to avoid collisions.',
        {
          entryName: entry.name,
          context: buildCollisionContext('unicode_nfc', existingNfc.original, entry.name, nfcName, 'tar')
        }
      );
    }

    const caseKey = toCollisionKey(targetName, entry.isDirectory);
    const existingCase = caseIndex.get(caseKey);
    if (existingCase && existingCase.target !== targetName) {
      if (params.onCaseCollision === 'error') {
        params.addIssue({
          code: 'TAR_CASE_COLLISION',
          severity: 'error',
          message: `Case-insensitive name collision: ${existingCase.original} vs ${entry.name}`,
          entryName: entry.name,
          details: { collisionKind: 'casefold', otherName: existingCase.original, key: caseKey }
        });
        throw new ArchiveError(
          'ARCHIVE_NAME_COLLISION',
          'Name collision detected (case). Rename entries to avoid collisions.',
          {
            entryName: entry.name,
            context: buildCollisionContext('case', existingCase.original, entry.name, caseKey, 'tar')
          }
        );
      }
      if (params.onCaseCollision === 'last-wins') {
        const previous = nameIndex.get(existingCase.target);
        if (previous !== undefined) {
          out[previous]!.dropped = true;
          params.summary.droppedEntries += 1;
        }
      } else if (params.onCaseCollision === 'rename') {
        targetName = resolveConflictName(targetName, nameIndex, caseIndex);
        renamed = true;
      }
    }

    nameIndex.set(targetName, out.length);
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
    }

    out.push({
      entry,
      normalizedName: targetName,
      dropped: false
    });
  }

  if (params.deterministic) {
    out.sort((a, b) => (a.normalizedName < b.normalizedName ? -1 : a.normalizedName > b.normalizedName ? 1 : 0));
  }

  return out;
}

function normalizeEntryName(entryName: string, isDirectory: boolean, addIssue: (issue: TarIssue) => void): string {
  if (entryName.includes('\u0000')) {
    addIssue({
      code: 'TAR_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Entry name contains NUL byte',
      entryName
    });
    throw new ArchiveError('ARCHIVE_PATH_TRAVERSAL', 'Entry name contains NUL byte', { entryName });
  }
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    addIssue({
      code: 'TAR_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Absolute paths are not allowed in TAR entries',
      entryName
    });
    throw new ArchiveError('ARCHIVE_PATH_TRAVERSAL', 'Absolute paths are not allowed in TAR entries', { entryName });
  }
  const parts = normalized.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.some((part) => part === '..')) {
    addIssue({
      code: 'TAR_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Path traversal detected in TAR entry',
      entryName
    });
    throw new ArchiveError('ARCHIVE_PATH_TRAVERSAL', 'Path traversal detected in TAR entry', { entryName });
  }
  let name = parts.join('/');
  if (isDirectory && !name.endsWith('/')) {
    name = name.length > 0 ? `${name}/` : '';
  }
  if (name.length === 0) {
    addIssue({
      code: 'TAR_PATH_TRAVERSAL',
      severity: 'error',
      message: 'Entry name resolves to empty path',
      entryName
    });
    throw new ArchiveError('ARCHIVE_PATH_TRAVERSAL', 'Entry name resolves to empty path', { entryName });
  }
  return name;
}

function buildCollisionContext(
  collisionType: 'duplicate' | 'case' | 'unicode_nfc',
  nameA: string,
  nameB: string,
  key: string,
  format: 'tar',
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

function resolveConflictName(name: string, nameIndex: Map<string, number>, lowerIndex: Map<string, unknown>): string {
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

function defaultMode(entry: TarEntry): number {
  if (entry.isDirectory) return 0o755;
  if (entry.isSymlink) return 0o777;
  return 0o644;
}

function clampMode(mode: number): number {
  return mode & 0o777;
}

function finalizeAuditReport(
  issues: TarIssue[],
  summary: { entries: number; warnings: number; errors: number; totalBytes?: number }
): TarAuditReport {
  const sanitizedIssues = issues.map((issue) => ({
    ...issue,
    ...(issue.details ? { details: sanitizeDetails(issue.details) as Record<string, unknown> } : {})
  }));
  const report = {
    schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
    ok: summary.errors === 0,
    summary,
    issues: sanitizedIssues
  } as TarAuditReport & { toJSON: () => unknown };
  report.toJSON = () => ({
    schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
    ok: report.ok,
    summary: report.summary,
    issues: sanitizedIssues.map(issueToJson)
  });
  return report;
}

function finalizeNormalizeReport(
  issues: TarIssue[],
  summary: {
    entries: number;
    outputEntries: number;
    droppedEntries: number;
    renamedEntries: number;
    warnings: number;
    errors: number;
  }
): TarNormalizeReport {
  const sanitizedIssues = issues.map((issue) => ({
    ...issue,
    ...(issue.details ? { details: sanitizeDetails(issue.details) as Record<string, unknown> } : {})
  }));
  const report = {
    schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
    ok: summary.errors === 0,
    summary,
    issues: sanitizedIssues
  } as TarNormalizeReport & { toJSON: () => unknown };
  report.toJSON = () => ({
    schemaVersion: BYTEFOLD_REPORT_SCHEMA_VERSION,
    ok: report.ok,
    summary: report.summary,
    issues: sanitizedIssues.map(issueToJson)
  });
  return report;
}

function issueToJson(issue: TarIssue): Record<string, unknown> {
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

function toSafeNumber(value: bigint): number | undefined {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(value);
}
