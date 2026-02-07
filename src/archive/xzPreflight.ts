import type { ArchiveLimits, ArchiveProfile, ArchiveFormat } from './types.js';
import { AGENT_RESOURCE_LIMITS, DEFAULT_RESOURCE_LIMITS } from '../limits.js';
import { resolveXzLimits } from '../compression/xz.js';

export function resolveXzIndexLimits(
  limits?: ArchiveLimits,
  profile?: ArchiveProfile
): { maxIndexRecords: number; maxIndexBytes: number } {
  const defaults = profile === 'agent' ? AGENT_RESOURCE_LIMITS : DEFAULT_RESOURCE_LIMITS;
  const rawRecords = limits?.maxXzIndexRecords;
  const rawBytes = limits?.maxXzIndexBytes;
  const maxIndexRecords =
    typeof rawRecords === 'number' && Number.isFinite(rawRecords)
      ? Math.max(1, Math.floor(rawRecords))
      : defaults.maxXzIndexRecords;
  const maxIndexBytes =
    typeof rawBytes === 'number' && Number.isFinite(rawBytes)
      ? Math.max(8, Math.floor(rawBytes))
      : defaults.maxXzIndexBytes;
  return { maxIndexRecords, maxIndexBytes };
}

export function resolveXzPreflightLimits(
  limits?: ArchiveLimits,
  profile?: ArchiveProfile
): { maxIndexRecords: number; maxIndexBytes: number; maxPreflightBlockHeaders: number } {
  const defaults = profile === 'agent' ? AGENT_RESOURCE_LIMITS : DEFAULT_RESOURCE_LIMITS;
  const { maxIndexRecords, maxIndexBytes } = resolveXzIndexLimits(limits, profile);
  const rawHeaders = limits?.maxXzPreflightBlockHeaders;
  const maxPreflightBlockHeaders =
    typeof rawHeaders === 'number' && Number.isFinite(rawHeaders)
      ? Math.max(0, Math.floor(rawHeaders))
      : defaults.maxXzPreflightBlockHeaders;
  return { maxIndexRecords, maxIndexBytes, maxPreflightBlockHeaders };
}

export function resolveXzDictionaryLimit(limits?: ArchiveLimits, profile?: ArchiveProfile): bigint {
  const maxDictionary = limits?.maxXzDictionaryBytes ?? limits?.maxDictionaryBytes;
  const maxBufferedInputBytes = limits?.maxXzBufferedBytes;
  const resolved = resolveXzLimits({
    ...(maxDictionary !== undefined ? { maxDictionaryBytes: maxDictionary } : {}),
    ...(maxBufferedInputBytes !== undefined ? { maxBufferedInputBytes } : {}),
    ...(profile ? { profile } : {})
  });
  return resolved.maxDictionaryBytes;
}

export function shouldPreflightXz(format: ArchiveFormat | 'auto' | undefined, filename?: string): boolean {
  if (format === 'xz' || format === 'tar.xz') return true;
  if (format && format !== 'auto') return false;
  if (!filename) return false;
  const lower = filename.toLowerCase();
  return lower.endsWith('.tar.xz') || lower.endsWith('.txz') || lower.endsWith('.xz');
}
