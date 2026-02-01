import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ZipError } from '../../errors.js';
import { mergeSignals, throwIfAborted } from '../../abort.js';
import { readableFromBytes, readableFromAsyncIterable, toWebReadable } from '../../streams/adapters.js';
import { FileSink, NodeWritableSink, WebWritableSink, type Sink, type SeekableSink } from './Sink.js';
import { writeEntry, type EntryWriteResult } from './entryWriter.js';
import { writeCentralDirectory } from '../../writer/centralDirectoryWriter.js';
import { finalizeArchive } from '../../writer/finalize.js';
import type { ZipEncryption, ZipWriterAddOptions, ZipWriterCloseOptions, ZipWriterOptions } from '../../types.js';

export class ZipWriter {
  private readonly entries: EntryWriteResult[] = [];
  private closed = false;
  private readonly forceZip64: boolean;
  private readonly defaultMethod: number;
  private readonly patchLocalHeaders: boolean;
  private readonly defaultEncryption: ZipEncryption;
  private readonly progress: {
    onProgress: (event: Parameters<NonNullable<ZipWriterOptions['onProgress']>>[0]) => void;
    progressIntervalMs?: number;
    progressChunkInterval?: number;
  } | undefined;
  private readonly signal: AbortSignal | undefined;

  private constructor(
    private readonly sink: Sink,
    options?: ZipWriterOptions
  ) {
    this.forceZip64 = options?.forceZip64 ?? false;
    this.defaultMethod = options?.defaultMethod ?? 8;
    const seekableMode = options?.seekable ?? 'auto';
    const seekable = isSeekableSink(sink);
    if (seekableMode === 'on' && !seekable) {
      throw new ZipError('ZIP_SINK_NOT_SEEKABLE', 'Seekable mode requires a seekable sink');
    }
    this.patchLocalHeaders = seekableMode === 'on' ? true : seekableMode === 'off' ? false : seekable;
    this.defaultEncryption = normalizeEncryption(options?.encryption, options?.password);
    this.progress = options?.onProgress
      ? {
          onProgress: options.onProgress,
          ...(options.progressIntervalMs !== undefined ? { progressIntervalMs: options.progressIntervalMs } : {}),
          ...(options.progressChunkInterval !== undefined ? { progressChunkInterval: options.progressChunkInterval } : {})
        }
      : undefined;
    this.signal = options?.signal;
  }

  static toWritable(
    writable: WritableStream<Uint8Array> | NodeJS.WritableStream,
    options?: ZipWriterOptions
  ): ZipWriter {
    const sink = isWebWritable(writable) ? new WebWritableSink(writable) : new NodeWritableSink(writable);
    return new ZipWriter(sink, options);
  }

  static async toFile(path: string | URL, options?: ZipWriterOptions): Promise<ZipWriter> {
    const sink = new FileSink(path);
    return new ZipWriter(sink, options);
  }

  async add(
    name: string,
    source: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | string | URL,
    options?: ZipWriterAddOptions & { declaredUncompressedSize?: bigint }
  ): Promise<void> {
    const signal = mergeSignals(this.signal, options?.signal);
    throwIfAborted(signal);
    if (this.closed) {
      throw new ZipError('ZIP_UNSUPPORTED_FEATURE', 'Cannot add entries after close');
    }
    if (name.includes('\u0000')) {
      throw new ZipError('ZIP_UNSUPPORTED_FEATURE', 'Entry names must not contain NUL');
    }

    const resolved = await resolveSource(source, options?.mtime, signal);
    const method = options?.method ?? this.defaultMethod;
    const zip64Mode = options?.zip64 ?? 'auto';
    const mtime = resolved.mtime ?? new Date();
    const externalAttributes = options?.externalAttributes ?? (name.endsWith('/') ? 0x10 : 0);
    const declaredUncompressedSize = (options as { declaredUncompressedSize?: bigint } | undefined)
      ?.declaredUncompressedSize;

    const entryInput = {
      name,
      source: resolved.stream,
      method,
      mtime,
      comment: options?.comment,
      externalAttributes,
      zip64Mode,
      forceZip64: this.forceZip64,
      patchLocalHeader: this.patchLocalHeaders,
      encryption: resolveEncryption(options, this.defaultEncryption),
      ...(this.progress ? { progress: this.progress } : {}),
      ...(signal ? { signal } : {})
    } as const;
    const entry = await writeEntry(this.patchLocalHeaders ? (this.sink as SeekableSink) : this.sink, {
      ...entryInput,
      ...(declaredUncompressedSize !== undefined ? { declaredUncompressedSize } : {}),
      ...(resolved.sizeHint !== undefined ? { sizeHint: resolved.sizeHint } : {})
    });

    this.entries.push(entry);
  }

  async close(comment?: string, options?: ZipWriterCloseOptions): Promise<void> {
    const signal = mergeSignals(this.signal, options?.signal);
    throwIfAborted(signal);
    if (this.closed) return;
    const cdInfo = await writeCentralDirectory(this.sink, this.entries, signal);
    const finalizeOptions: {
      entryCount: bigint;
      cdOffset: bigint;
      cdSize: bigint;
      forceZip64: boolean;
      hasZip64Entries: boolean;
      comment?: string;
    } = {
      entryCount: BigInt(this.entries.length),
      cdOffset: cdInfo.offset,
      cdSize: cdInfo.size,
      forceZip64: this.forceZip64,
      hasZip64Entries: this.entries.some((entry) => entry.zip64)
    };
    if (comment !== undefined) finalizeOptions.comment = comment;
    await finalizeArchive(this.sink, finalizeOptions, signal);
    throwIfAborted(signal);
    await this.sink.close();
    this.closed = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

function isSeekableSink(sink: Sink): sink is SeekableSink {
  return typeof (sink as SeekableSink).writeAt === 'function';
}

function isWebWritable(stream: WritableStream<Uint8Array> | NodeJS.WritableStream): stream is WritableStream<Uint8Array> {
  return typeof (stream as WritableStream<Uint8Array>).getWriter === 'function';
}

async function resolveSource(
  source:
    | Uint8Array
    | ArrayBuffer
    | ReadableStream<Uint8Array>
    | AsyncIterable<Uint8Array>
    | string
    | URL,
  mtime?: Date,
  signal?: AbortSignal
): Promise<{ stream: ReadableStream<Uint8Array>; sizeHint?: bigint; mtime?: Date }> {
  throwIfAborted(signal);
  if (source instanceof Uint8Array) {
    return mtime
      ? { stream: readableFromBytes(source), sizeHint: BigInt(source.length), mtime }
      : { stream: readableFromBytes(source), sizeHint: BigInt(source.length) };
  }
  if (source instanceof ArrayBuffer) {
    const view = new Uint8Array(source);
    return mtime
      ? { stream: readableFromBytes(view), sizeHint: BigInt(view.length), mtime }
      : { stream: readableFromBytes(view), sizeHint: BigInt(view.length) };
  }
  if (typeof source === 'string' || source instanceof URL) {
    const filePath = typeof source === 'string' ? source : fileURLToPath(source);
    const stats = await stat(filePath);
    throwIfAborted(signal);
    if (stats.isDirectory()) {
      return { stream: readableFromBytes(new Uint8Array(0)), sizeHint: 0n, mtime: stats.mtime };
    }
    const stream = toWebReadable(createReadStream(filePath));
    return { stream, sizeHint: BigInt(stats.size), mtime: stats.mtime };
  }
  if (isReadableStream(source)) {
    return mtime ? { stream: source, mtime } : { stream: source };
  }
  return mtime ? { stream: readableFromAsyncIterable(source), mtime } : { stream: readableFromAsyncIterable(source) };
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof (value as ReadableStream<Uint8Array>).getReader === 'function';
}

function resolveEncryption(options: ZipWriterAddOptions | undefined, fallback: ZipEncryption): ZipEncryption {
  if (options?.encryption) return normalizeEncryption(options.encryption);
  if (options?.password !== undefined) {
    return normalizeEncryption({ type: 'zipcrypto', password: options.password });
  }
  return fallback;
}

function normalizeEncryption(encryption?: ZipEncryption, password?: string): ZipEncryption {
  if (!encryption) {
    if (password !== undefined) {
      return normalizeEncryption({ type: 'zipcrypto', password });
    }
    return { type: 'none' };
  }
  switch (encryption.type) {
    case 'none':
      return { type: 'none' };
    case 'zipcrypto': {
      if (encryption.password === undefined) {
        throw new ZipError('ZIP_PASSWORD_REQUIRED', 'Password required for ZipCrypto encryption');
      }
      return { type: 'zipcrypto', password: encryption.password };
    }
    case 'aes': {
      if (encryption.password === undefined) {
        throw new ZipError('ZIP_PASSWORD_REQUIRED', 'Password required for AES encryption');
      }
      const strength = encryption.strength ?? 256;
      if (strength !== 128 && strength !== 192 && strength !== 256) {
        throw new ZipError('ZIP_UNSUPPORTED_ENCRYPTION', `Unsupported AES strength ${strength}`);
      }
      const vendorVersion = encryption.vendorVersion ?? 2;
      if (vendorVersion !== 1 && vendorVersion !== 2) {
        throw new ZipError('ZIP_UNSUPPORTED_ENCRYPTION', `Unsupported AES vendor version ${vendorVersion}`);
      }
      return {
        type: 'aes',
        password: encryption.password,
        strength,
        vendorVersion
      };
    }
    default: {
      const exhaustive: never = encryption;
      return exhaustive;
    }
  }
}
