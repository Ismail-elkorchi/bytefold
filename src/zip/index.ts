/** ZIP random-access reader implementation. */
export { ZipReader } from '../reader/ZipReader.js';
/** ZIP writer implementation for stream outputs. */
export { ZipWriter } from '../writer/ZipWriter.js';
/** Typed ZIP-domain error class. */
export { ZipError } from '../errors.js';
/** Stable ZIP error code union. */
export type { ZipErrorCode } from '../errors.js';
/** ZIP audit/normalize/extract/options/report/domain types. */
export type {
  CompressionMethod,
  ZipAuditOptions,
  ZipAuditReport,
  ZipNormalizeConflict,
  ZipNormalizeMode,
  ZipNormalizeOptions,
  ZipNormalizeReport,
  ZipEncryption,
  ZipEntry,
  ZipExtractOptions,
  ZipIssue,
  ZipIssueSeverity,
  ZipLimits,
  ZipProfile,
  ZipProgressEvent,
  ZipProgressOptions,
  ZipReaderIterOptions,
  ZipReaderOpenOptions,
  ZipReaderOptions,
  ZipWarning,
  ZipWriterAddOptions,
  ZipWriterCloseOptions,
  Zip64Mode,
  ZipWriterOptions
} from '../types.js';

/** Register a runtime compression codec for ZIP methods. */
export { registerCompressionCodec, listCompressionCodecs } from '../compression/registry.js';
/** Compression codec and stream contract types for ZIP. */
export type {
  ZipCompressionCodec,
  ZipCompressionStream,
  ZipCompressionOptions,
  ZipDecompressionOptions
} from '../compression/types.js';
