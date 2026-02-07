import type { ArchiveFormat, ArchiveLimits, ArchiveProfile } from './types.js';
import { AGENT_RESOURCE_LIMITS, DEFAULT_RESOURCE_LIMITS } from '../limits.js';
import type { RandomAccess } from '../reader/RandomAccess.js';
import { findEocd, type EocdResult } from '../reader/eocd.js';

export type ZipPreflightLimits = {
  maxCentralDirectoryBytes: number;
  maxEntries: number;
  maxCommentBytes: number;
  maxEocdSearchBytes: number;
};

export function resolveZipPreflightLimits(
  limits?: ArchiveLimits,
  profile?: ArchiveProfile
): ZipPreflightLimits {
  const defaults = profile === 'agent' ? AGENT_RESOURCE_LIMITS : DEFAULT_RESOURCE_LIMITS;
  const maxCentralDirectoryBytes =
    typeof limits?.maxZipCentralDirectoryBytes === 'number' && Number.isFinite(limits.maxZipCentralDirectoryBytes)
      ? Math.max(0, Math.floor(limits.maxZipCentralDirectoryBytes))
      : defaults.maxZipCentralDirectoryBytes;
  const maxEntries =
    typeof limits?.maxEntries === 'number' && Number.isFinite(limits.maxEntries)
      ? Math.max(0, Math.floor(limits.maxEntries))
      : defaults.maxEntries;
  const maxCommentBytes =
    typeof limits?.maxZipCommentBytes === 'number' && Number.isFinite(limits.maxZipCommentBytes)
      ? Math.max(0, Math.floor(limits.maxZipCommentBytes))
      : defaults.maxZipCommentBytes;
  const maxEocdSearchBytes =
    typeof limits?.maxZipEocdSearchBytes === 'number' && Number.isFinite(limits.maxZipEocdSearchBytes)
      ? Math.max(22, Math.floor(limits.maxZipEocdSearchBytes))
      : defaults.maxZipEocdSearchBytes;
  return { maxCentralDirectoryBytes, maxEntries, maxCommentBytes, maxEocdSearchBytes };
}

export function shouldPreflightZip(format: ArchiveFormat | 'auto' | undefined, filename?: string): boolean {
  if (format === 'zip') return true;
  if (format && format !== 'auto') return false;
  if (!filename) return false;
  const lower = filename.toLowerCase();
  return lower.endsWith('.zip') || lower.endsWith('.cbz');
}

export function isZipSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  const b2 = bytes[2];
  const b3 = bytes[3];
  return (
    (b2 === 0x03 && b3 === 0x04) ||
    (b2 === 0x05 && b3 === 0x06) ||
    (b2 === 0x07 && b3 === 0x08) ||
    (b2 === 0x01 && b3 === 0x02)
  );
}

export async function preflightZip(
  reader: RandomAccess,
  options: { strict: boolean; limits: ZipPreflightLimits; signal?: AbortSignal }
): Promise<EocdResult> {
  return findEocd(reader, options.strict, options.signal, {
    maxSearchBytes: options.limits.maxEocdSearchBytes,
    maxCommentBytes: options.limits.maxCommentBytes,
    maxCentralDirectoryBytes: options.limits.maxCentralDirectoryBytes,
    maxEntries: options.limits.maxEntries,
    rejectMultiDisk: true
  });
}
