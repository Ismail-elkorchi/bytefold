import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ArchiveOpenOptions } from '../archive/types.js';
import { openArchive as openArchiveCore, type ArchiveReader } from '../archive/index.js';
import { toWebReadable } from '../streams/adapters.js';

export { ArchiveError } from '../archive/errors.js';
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
} from '../archive/types.js';
export type { ArchiveReader, ArchiveWriter } from '../archive/index.js';
export { createArchiveWriter } from '../archive/index.js';

export * from './zip/index.js';
export * from '../tar/index.js';

export { toWebReadable, toWebWritable, toNodeReadable, toNodeWritable } from '../streams/adapters.js';

export type NodeArchiveInput =
  | Uint8Array
  | ArrayBuffer
  | ReadableStream<Uint8Array>
  | NodeJS.ReadableStream
  | string
  | URL;

export async function openArchive(input: NodeArchiveInput, options?: ArchiveOpenOptions): Promise<ArchiveReader> {
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    return openArchiveCore(input, {
      ...options,
      ...(options?.inputKind ? {} : { inputKind: 'bytes' })
    });
  }
  if (typeof input === 'string' || input instanceof URL) {
    const filePath = typeof input === 'string' ? input : fileURLToPath(input);
    const data = new Uint8Array(await readFile(filePath));
    return openArchiveCore(data, {
      ...options,
      ...(options?.inputKind ? {} : { inputKind: input instanceof URL ? 'url' : 'file' }),
      ...(options?.filename ? {} : { filename: filePath })
    });
  }
  if (isReadableStream(input)) {
    return openArchiveCore(input, {
      ...options,
      ...(options?.inputKind ? {} : { inputKind: 'stream' })
    });
  }
  const webStream = toWebReadable(input as NodeJS.ReadableStream);
  return openArchiveCore(webStream, {
    ...options,
    ...(options?.inputKind ? {} : { inputKind: 'stream' })
  });
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof (value as ReadableStream<Uint8Array>).getReader === 'function';
}
