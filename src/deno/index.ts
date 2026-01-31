import type { ArchiveOpenOptions } from '../archive/types.js';
import type { ArchiveReader } from '../archive/index.js';
import { openArchive as openArchiveCore } from '../archive/index.js';
import { ZipReader } from '../reader/ZipReader.js';
import { ZipWriter } from '../writer/ZipWriter.js';
import { TarReader } from '../tar/TarReader.js';
import { TarWriter } from '../tar/TarWriter.js';

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

export * from '../zip/index.js';
export * from '../tar/index.js';

const DenoGlobal = (globalThis as any).Deno as any;

export type DenoArchiveInput = Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | string | URL;

export async function openArchive(input: DenoArchiveInput, options?: ArchiveOpenOptions): Promise<ArchiveReader> {
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    return openArchiveCore(input, {
      ...options,
      ...(options?.inputKind ? {} : { inputKind: 'bytes' })
    });
  }
  if (typeof input === 'string' || input instanceof URL) {
    const path = typeof input === 'string' ? input : input.toString();
    const data = new Uint8Array(await DenoGlobal.readFile(path));
    return openArchiveCore(data, {
      ...options,
      ...(options?.inputKind ? {} : { inputKind: input instanceof URL ? 'url' : 'file' }),
      ...(options?.filename ? {} : { filename: path })
    });
  }
  return openArchiveCore(input, {
    ...options,
    ...(options?.inputKind ? {} : { inputKind: 'stream' })
  });
}

export async function zipFromFile(path: string, options?: Parameters<typeof ZipReader.fromUint8Array>[1]) {
  const data = new Uint8Array(await DenoGlobal.readFile(path));
  return ZipReader.fromUint8Array(data, options);
}

export async function tarFromFile(path: string, options?: Parameters<typeof TarReader.fromUint8Array>[1]) {
  const data = new Uint8Array(await DenoGlobal.readFile(path));
  return TarReader.fromUint8Array(data, options);
}

export async function zipToFile(path: string, options?: Parameters<typeof ZipWriter.toWritable>[1]) {
  const file = await DenoGlobal.open(path, { create: true, write: true, truncate: true });
  const writer = ZipWriter.toWritable(file.writable, options);
  const close = writer.close.bind(writer);
  writer.close = async (...args: Parameters<typeof close>) => {
    await close(...args);
    try {
      file.close();
    } catch {
      // Deno may already close the resource when the stream closes.
    }
  };
  return writer;
}

export async function tarToFile(path: string, options?: Parameters<typeof TarWriter.toWritable>[1]) {
  const file = await DenoGlobal.open(path, { create: true, write: true, truncate: true });
  const writer = TarWriter.toWritable(file.writable, options);
  const close = writer.close.bind(writer);
  writer.close = async (...args: Parameters<typeof close>) => {
    await close(...args);
    try {
      file.close();
    } catch {
      // Deno may already close the resource when the stream closes.
    }
  };
  return writer;
}
