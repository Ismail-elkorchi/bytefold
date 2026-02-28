/**
 * Primary bytefold entrypoint exports for archive and compression APIs.
 */
/** Archive open/read/write primitives and adapters. */
export * from './archive/index.js';
/** Typed archive error class. */
export { ArchiveError } from './archive/errors.js';
/** Stable archive error code union. */
export type { ArchiveErrorCode } from './archive/errors.js';
/** Archive report/input/options/domain types. */
export type {
  ArchiveAuditReport,
  ArchiveDetectionReport,
  ArchiveEntry,
  ArchiveFormat,
  ArchiveInputKind,
  ArchiveIssue,
  ArchiveIssueSeverity,
  ArchiveLimits,
  ArchiveNormalizeReport,
  ArchiveOpenOptions,
  ArchiveProfile
} from './archive/types.js';
/** Resource-limit policy type shared across profiles. */
export type { ResourceLimits } from './limits.js';

/** ZIP reader/writer APIs and ZIP-domain types. */
export * from './zip/index.js';
/** TAR reader/writer APIs and TAR-domain types. */
export * from './tar/index.js';
/** Compression capability and stream-transform APIs. */
export * from './compress/index.js';
/** Stable report schema version constant. */
export { BYTEFOLD_REPORT_SCHEMA_VERSION } from './reportSchema.js';
