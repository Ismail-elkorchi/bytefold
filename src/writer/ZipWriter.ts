import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ZipError } from '../errors.js';
import { readableFromBytes, readableFromAsyncIterable, toWebReadable } from '../streams/adapters.js';
import type { ZipWriterAddOptions, ZipWriterOptions } from '../types.js';
import type { SeekableSink, Sink } from './Sink.js';
import { FileSink, NodeWritableSink, WebWritableSink } from './Sink.js';
import { writeEntry, type EntryWriteResult } from './entryWriter.js';
import { writeCentralDirectory } from './centralDirectoryWriter.js';
import { finalizeArchive } from './finalize.js';

export class ZipWriter {
  private readonly entries: EntryWriteResult[] = [];
  private closed = false;
  private readonly forceZip64: boolean;
  private readonly defaultMethod: number;
  private readonly patchLocalHeaders: boolean;

  private constructor(private readonly sink: Sink, options?: ZipWriterOptions) {
    this.forceZip64 = options?.forceZip64 ?? false;
    this.defaultMethod = options?.defaultMethod ?? 8;
    const seekableMode = options?.seekable ?? 'auto';
    const seekable = isSeekableSink(sink);
    if (seekableMode === 'on' && !seekable) {
      throw new ZipError('ZIP_SINK_NOT_SEEKABLE', 'Seekable mode requires a seekable sink');
    }
    this.patchLocalHeaders = seekableMode === 'on' ? true : seekableMode === 'off' ? false : seekable;
  }

  static toWritable(writable: WritableStream<Uint8Array> | NodeJS.WritableStream, options?: ZipWriterOptions): ZipWriter {
    const sink = isWebWritable(writable) ? new WebWritableSink(writable) : new NodeWritableSink(writable);
    return new ZipWriter(sink, options);
  }

  static async toFile(path: string | URL, options?: ZipWriterOptions): Promise<ZipWriter> {
    const sink = new FileSink(path);
    return new ZipWriter(sink, options);
  }

  async add(
    name: string,
    source:
      | Uint8Array
      | ArrayBuffer
      | ReadableStream<Uint8Array>
      | AsyncIterable<Uint8Array>
      | string
      | URL,
    options?: ZipWriterAddOptions
  ): Promise<void> {
    if (this.closed) {
      throw new ZipError('ZIP_UNSUPPORTED_FEATURE', 'Cannot add entries after close');
    }
    if (name.includes('\u0000')) {
      throw new ZipError('ZIP_UNSUPPORTED_FEATURE', 'Entry names must not contain NUL');
    }

    const resolved = await resolveSource(source, options?.mtime);
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
      patchLocalHeader: this.patchLocalHeaders
    } as const;
    const entry = await writeEntry(this.patchLocalHeaders ? (this.sink as SeekableSink) : this.sink, {
      ...entryInput,
      ...(declaredUncompressedSize !== undefined ? { declaredUncompressedSize } : {}),
      ...(resolved.sizeHint !== undefined ? { sizeHint: resolved.sizeHint } : {})
    });

    this.entries.push(entry);
  }

  async close(comment?: string): Promise<void> {
    if (this.closed) return;
    const cdInfo = await writeCentralDirectory(this.sink, this.entries);
    await finalizeArchive(this.sink, {
      entryCount: BigInt(this.entries.length),
      cdOffset: cdInfo.offset,
      cdSize: cdInfo.size,
      forceZip64: this.forceZip64,
      hasZip64Entries: this.entries.some((entry) => entry.zip64),
      comment
    });
    await this.sink.close();
    this.closed = true;
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
  mtime?: Date
): Promise<{ stream: ReadableStream<Uint8Array>; sizeHint?: bigint; mtime?: Date }> {
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
