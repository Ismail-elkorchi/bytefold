/** Shared resource ceilings for archive and compression operations. */
export type ResourceLimits = {
  /** Maximum allowed XZ dictionary size in bytes. */
  maxXzDictionaryBytes?: bigint | number;
  /** Maximum XZ decoder buffered input bytes. */
  maxXzBufferedBytes?: number;
  /** Maximum number of XZ index records accepted. */
  maxXzIndexRecords?: number;
  /** Maximum total XZ index bytes accepted. */
  maxXzIndexBytes?: number;
  /** Maximum XZ block headers scanned during preflight. */
  maxXzPreflightBlockHeaders?: number;
  /** Maximum ZIP central directory bytes accepted. */
  maxZipCentralDirectoryBytes?: number;
  /** Maximum ZIP comment bytes accepted. */
  maxZipCommentBytes?: number;
  /** Maximum bytes scanned while locating ZIP EOCD. */
  maxZipEocdSearchBytes?: number;
  /** Maximum BZip2 block size level (1-9). */
  maxBzip2BlockSize?: number;
  /** Maximum decompressed output bytes produced by a pipeline. */
  maxTotalDecompressedBytes?: bigint | number;
  /** Maximum raw input bytes consumed from the source. */
  maxInputBytes?: bigint | number;
  /** Maximum number of archive entries processed. */
  maxEntries?: number;
  /** Maximum uncompressed bytes for any single entry. */
  maxUncompressedEntryBytes?: bigint | number;
  /** Maximum uncompressed bytes across all processed entries. */
  maxTotalUncompressedBytes?: bigint | number;
  /** Maximum allowed expansion ratio for compressed data. */
  maxCompressionRatio?: number;
  /** Generic dictionary size ceiling for codecs that use dictionaries. */
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
