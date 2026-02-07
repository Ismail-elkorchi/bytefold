/** Shared resource ceilings for archive and compression operations. */
export type ResourceLimits = {
  maxXzDictionaryBytes?: bigint | number;
  maxXzBufferedBytes?: number;
  maxXzIndexRecords?: number;
  maxXzIndexBytes?: number;
  maxXzPreflightBlockHeaders?: number;
  maxZipCentralDirectoryBytes?: number;
  maxZipCommentBytes?: number;
  maxZipEocdSearchBytes?: number;
  maxBzip2BlockSize?: number;
  maxTotalDecompressedBytes?: bigint | number;
  maxInputBytes?: bigint | number;
  maxEntries?: number;
  maxUncompressedEntryBytes?: bigint | number;
  maxTotalUncompressedBytes?: bigint | number;
  maxCompressionRatio?: number;
  maxDictionaryBytes?: bigint | number;
};

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 10000,
  maxUncompressedEntryBytes: 512n * 1024n * 1024n,
  maxTotalUncompressedBytes: 2n * 1024n * 1024n * 1024n,
  maxTotalDecompressedBytes: 2n * 1024n * 1024n * 1024n,
  maxCompressionRatio: 1000,
  maxDictionaryBytes: 64n * 1024n * 1024n,
  maxXzDictionaryBytes: 64n * 1024n * 1024n,
  maxXzBufferedBytes: 1024 * 1024,
  maxXzIndexRecords: 1_000_000,
  maxXzIndexBytes: 64 * 1024 * 1024,
  maxXzPreflightBlockHeaders: 1024,
  maxZipCentralDirectoryBytes: 64 * 1024 * 1024,
  maxZipCommentBytes: 0xffff,
  maxZipEocdSearchBytes: 0x10000 + 22,
  maxBzip2BlockSize: 9,
  maxInputBytes: 2n * 1024n * 1024n * 1024n
} satisfies Required<ResourceLimits>);

const AGENT_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxUncompressedEntryBytes: 256n * 1024n * 1024n,
  maxTotalUncompressedBytes: 1024n * 1024n * 1024n,
  maxTotalDecompressedBytes: 1024n * 1024n * 1024n,
  maxCompressionRatio: 200,
  maxDictionaryBytes: 32n * 1024n * 1024n,
  maxXzDictionaryBytes: 32n * 1024n * 1024n,
  maxXzBufferedBytes: 1024 * 1024,
  maxXzIndexRecords: 200_000,
  maxXzIndexBytes: 16 * 1024 * 1024,
  maxXzPreflightBlockHeaders: 256,
  maxZipCentralDirectoryBytes: 16 * 1024 * 1024,
  maxZipCommentBytes: 16 * 1024,
  maxZipEocdSearchBytes: 0x10000 + 22,
  maxBzip2BlockSize: 9,
  maxInputBytes: 1024n * 1024n * 1024n
} satisfies Required<ResourceLimits>);

export const DEFAULT_RESOURCE_LIMITS: Required<ResourceLimits> = DEFAULT_LIMITS;
export const AGENT_RESOURCE_LIMITS: Required<ResourceLimits> = AGENT_LIMITS;
