import type { ArchiveOpenOptions } from '../archive/types.js';
import { openArchive as openArchiveCore, type ArchiveReader } from '../archive/index.js';
import { ZipReader } from '../reader/ZipReader.js';
import { ZipWriter } from '../writer/ZipWriter.js';
import { TarReader } from '../tar/TarReader.js';
import { TarWriter } from '../tar/TarWriter.js';

type BunFile = { arrayBuffer: () => Promise<ArrayBuffer> };
type BunApi = {
  file: (path: string) => BunFile;
  write: (path: string, data: Uint8Array) => Promise<unknown> | unknown;
};

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

const BunGlobal = (globalThis as { Bun?: BunApi }).Bun;

function requireBun(): BunApi {
  if (!BunGlobal) {
    throw new Error('Bun global is not available in this runtime.');
  }
  return BunGlobal;
}

export type BunArchiveInput = Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | string | URL;

export async function openArchive(input: BunArchiveInput, options?: ArchiveOpenOptions): Promise<ArchiveReader> {
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    return openArchiveCore(input, {
      ...options,
      ...(options?.inputKind ? {} : { inputKind: 'bytes' })
    });
  }
  if (typeof input === 'string' || input instanceof URL) {
    const path = typeof input === 'string' ? input : input.toString();
    const data = new Uint8Array(await requireBun().file(path).arrayBuffer());
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

export async function zipFromFile(
  path: string,
  options?: Parameters<typeof ZipReader.fromUint8Array>[1]
): Promise<ZipReader> {
  const data = new Uint8Array(await requireBun().file(path).arrayBuffer());
  return ZipReader.fromUint8Array(data, options);
}

export async function tarFromFile(
  path: string,
  options?: Parameters<typeof TarReader.fromUint8Array>[1]
): Promise<TarReader> {
  const data = new Uint8Array(await requireBun().file(path).arrayBuffer());
  return TarReader.fromUint8Array(data, options);
}

export async function zipToFile(
  path: string,
  options?: Parameters<typeof ZipWriter.toWritable>[1]
): Promise<ZipWriter> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = ZipWriter.toWritable(writable, options);
  const close = writer.close.bind(writer);
  writer.close = async (...args: Parameters<typeof close>) => {
    await close(...args);
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    await requireBun().write(path, out);
  };
  return writer;
}

export async function tarToFile(
  path: string,
  options?: Parameters<typeof TarWriter.toWritable>[1]
): Promise<TarWriter> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = TarWriter.toWritable(writable, options);
  const close = writer.close.bind(writer);
  writer.close = async (...args: Parameters<typeof close>) => {
    await close(...args);
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    await requireBun().write(path, out);
  };
  return writer;
}
