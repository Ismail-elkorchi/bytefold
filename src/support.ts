/**
 * Machine-consumable runtime support matrix exported from bytefold.
 */
import type { ArchiveFormat } from './archive/types.js';

/**
 * Bytefold archive operation identifiers used by the support matrix.
 */
export type ArchiveOperation = 'detect' | 'list' | 'audit' | 'extract' | 'normalize' | 'write';

/**
 * Runtime identifiers used by the support matrix.
 */
export type BytefoldRuntime = 'node' | 'deno' | 'bun' | 'web';

/**
 * Support status for one format × operation cell.
 */
export type SupportState = 'supported' | 'unsupported' | 'hint-required' | 'capability-gated';

/**
 * Detailed support descriptor for one matrix cell.
 */
export interface SupportCell {
  state: SupportState;
  errorCode?: string;
  note?: string;
}

/**
 * JSON support-matrix block from SPEC.md.
 */
export type SupportMatrix = {
  formats: readonly ArchiveFormat[];
  operations: readonly ArchiveOperation[];
  runtimes: readonly BytefoldRuntime[];
};

/**
 * JSON support-matrix block from SPEC.md.
 */
export const supportMatrix: SupportMatrix = {
  formats: [
    'zip',
    'tar',
    'tgz',
    'tar.gz',
    'gz',
    'bz2',
    'tar.bz2',
    'zst',
    'tar.zst',
    'br',
    'tar.br',
    'xz',
    'tar.xz'
  ],
  operations: ['detect', 'list', 'audit', 'extract', 'normalize', 'write'],
  runtimes: ['node', 'deno', 'bun', 'web']
};

/**
 * Per-format support for one runtime.
 */
export type RuntimeSupport = Record<
  ArchiveFormat,
  Record<ArchiveOperation, SupportCell>
>;

/**
 * Per-runtime support map.
 */
export type RuntimeSupportMap = Record<BytefoldRuntime, RuntimeSupport>;

const singleFileFormats = new Set<ArchiveFormat>(['gz', 'bz2', 'xz', 'zst', 'br']);

const runtimeSupportMap: RuntimeSupportMap = {
  node: createNodeLikeSupport(),
  deno: createDenoSupport(),
  bun: createNodeLikeSupport(),
  web: createWebSupport()
};

/**
 * Return support details aligned with SPEC.md runtime tables.
 * When no runtime is provided, the result includes all runtimes.
 */
export function runtimeSupport(): RuntimeSupportMap;
/**
 * Return support details for exactly one runtime.
 */
export function runtimeSupport(runtime: BytefoldRuntime): RuntimeSupport;
/**
 * Implementation signature for the runtime support accessor.
 */
export function runtimeSupport(runtime?: BytefoldRuntime): RuntimeSupport | RuntimeSupportMap {
  if (runtime) {
    return cloneRuntimeSupport(runtimeSupportMap[runtime]);
  }
  return {
    node: cloneRuntimeSupport(runtimeSupportMap.node),
    deno: cloneRuntimeSupport(runtimeSupportMap.deno),
    bun: cloneRuntimeSupport(runtimeSupportMap.bun),
    web: cloneRuntimeSupport(runtimeSupportMap.web)
  };
}

function createNodeLikeSupport(): RuntimeSupport {
  const matrix = createFullySupportedRuntime();

  for (const format of singleFileFormats) {
    matrix[format].normalize = unsupported('ARCHIVE_UNSUPPORTED_FEATURE');
  }

  for (const format of ['tar.bz2', 'bz2', 'tar.xz', 'xz'] as const) {
    matrix[format].write = unsupported('ARCHIVE_UNSUPPORTED_FORMAT');
  }

  matrix['tar.br'].detect = hintRequired('Specify format "tar.br" or a filename hint.');
  matrix.br.detect = hintRequired('Specify format "br" or a filename hint.');

  return matrix;
}

function createDenoSupport(): RuntimeSupport {
  const matrix = createNodeLikeSupport();
  for (const format of ['tar.zst', 'zst', 'tar.br', 'br'] as const) {
    for (const operation of supportMatrix.operations) {
      matrix[format][operation] = capabilityGated('COMPRESSION_UNSUPPORTED_ALGORITHM');
    }
  }
  return matrix;
}

function createWebSupport(): RuntimeSupport {
  const matrix = createNodeLikeSupport();

  for (const operation of supportMatrix.operations) {
    matrix['tar.zst'][operation] = capabilityGated('COMPRESSION_UNSUPPORTED_ALGORITHM');
  }

  for (const operation of ['detect', 'list', 'audit', 'extract', 'write'] as const) {
    matrix.zst[operation] = capabilityGated('COMPRESSION_UNSUPPORTED_ALGORITHM');
  }
  matrix.zst.normalize = unsupported('ARCHIVE_UNSUPPORTED_FEATURE');

  matrix['tar.br'].detect = hintRequired(
    'Specify format "tar.br" or a filename hint; capability-gated when brotli streams are unavailable.'
  );
  matrix.br.detect = hintRequired(
    'Specify format "br" or a filename hint; capability-gated when brotli streams are unavailable.'
  );
  matrix['tar.br'].write = capabilityGated('COMPRESSION_UNSUPPORTED_ALGORITHM');
  matrix.br.write = capabilityGated('COMPRESSION_UNSUPPORTED_ALGORITHM');

  return matrix;
}

function createFullySupportedRuntime(): RuntimeSupport {
  const matrix = {} as RuntimeSupport;
  for (const format of supportMatrix.formats) {
    const operations = {} as Record<ArchiveOperation, SupportCell>;
    for (const operation of supportMatrix.operations) {
      operations[operation] = supported();
    }
    matrix[format] = operations;
  }
  return matrix;
}

function cloneRuntimeSupport(runtime: RuntimeSupport): RuntimeSupport {
  const cloned = {} as RuntimeSupport;
  for (const format of supportMatrix.formats) {
    cloned[format] = {} as Record<ArchiveOperation, SupportCell>;
    for (const operation of supportMatrix.operations) {
      const cell = runtime[format][operation];
      cloned[format][operation] = { ...cell };
    }
  }
  return cloned;
}

function supported(): SupportCell {
  return { state: 'supported' };
}

function unsupported(errorCode: string, note?: string): SupportCell {
  return {
    state: 'unsupported',
    errorCode,
    ...(note ? { note } : {})
  };
}

function hintRequired(note: string): SupportCell {
  return {
    state: 'hint-required',
    note
  };
}

function capabilityGated(errorCode: string, note?: string): SupportCell {
  return {
    state: 'capability-gated',
    errorCode,
    ...(note ? { note } : {})
  };
}
