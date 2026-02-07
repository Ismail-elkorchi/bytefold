import { ArchiveError } from '../archive/errors.js';
import { readAllBytes } from '../streams/buffer.js';
import { readableFromAsyncIterable, readableFromBytes } from '../streams/web.js';
import { throwIfAborted } from '../abort.js';
import type { TarEntryType, TarWriterAddOptions, TarWriterOptions } from './types.js';

const BLOCK_SIZE = 512;
const TEXT_ENCODER = new TextEncoder();

/** Write TAR archives to a writable stream. */
export class TarWriter {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly deterministic: boolean;
  private readonly signal: AbortSignal | undefined;
  private closed = false;
  private paxCounter = 0;

  private constructor(stream: WritableStream<Uint8Array>, options?: TarWriterOptions) {
    this.writer = stream.getWriter();
    this.deterministic = options?.isDeterministic ?? false;
    this.signal = options?.signal;
  }

  /** Create a TAR writer that targets a WritableStream. */
  static toWritable(writable: WritableStream<Uint8Array>, options?: TarWriterOptions): TarWriter {
    return new TarWriter(writable, options);
  }

  /** Add an entry to the TAR archive. */
  async add(
    name: string,
    source?: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    options?: TarWriterAddOptions
  ): Promise<void> {
    throwIfAborted(this.signal);
    if (this.closed) throw new ArchiveError('ARCHIVE_UNSUPPORTED_FEATURE', 'Writer is closed');
    if (name.includes('\u0000')) {
      throw new ArchiveError('ARCHIVE_PATH_TRAVERSAL', 'Entry name contains NUL byte', { entryName: name });
    }

    const type = options?.type ?? inferType(name, options);
    const normalizedName = type === 'directory' && !name.endsWith('/') ? `${name}/` : name;

    const resolved = await resolveSource(source, options?.size, this.signal);
    const size = type === 'directory' || type === 'symlink' || type === 'link' ? 0n : resolved.size;
    const mtime = resolveMtime(options?.mtime, this.deterministic);
    const mode = resolveMode(options?.mode, type, this.deterministic);
    const uid = resolveId(options?.uid, this.deterministic);
    const gid = resolveId(options?.gid, this.deterministic);
    const uname = this.deterministic ? '' : options?.uname ?? '';
    const gname = this.deterministic ? '' : options?.gname ?? '';

    const paxRecords: Record<string, string> = { ...(options?.pax ?? {}) };
    const nameForHeader = fitName(normalizedName, paxRecords, 'path');
    const linkName = options?.linkName ?? '';
    const linkForHeader = fitName(linkName, paxRecords, 'linkpath');

    if (mtime && !Number.isInteger(mtime.getTime() / 1000)) {
      paxRecords.mtime = (mtime.getTime() / 1000).toString();
    }

    if (!fitsInOctal(size, 12)) {
      paxRecords.size = size.toString();
    }

    if (Object.keys(paxRecords).length > 0) {
      await this.writePaxHeader(paxRecords, uid, gid, uname, gname, mtime);
    }

    const header = createTarHeader({
      name: nameForHeader,
      mode,
      uid,
      gid,
      size,
      ...(mtime ? { mtime } : {}),
      type,
      linkName: linkForHeader,
      uname,
      gname
    });
    await this.writeChunk(header);

    if (size > 0n && resolved.stream) {
      await this.pipeData(resolved.stream);
    }
    await this.writePadding(size);
  }

  /** Finalize and close the TAR archive. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.writeChunk(new Uint8Array(BLOCK_SIZE));
    await this.writeChunk(new Uint8Array(BLOCK_SIZE));
    await this.writer.close();
    this.closed = true;
  }

  /** @internal */
  private async writePaxHeader(
    records: Record<string, string>,
    uid: number,
    gid: number,
    uname: string,
    gname: string,
    mtime: Date | undefined
  ): Promise<void> {
    const data = encodePaxRecords(records);
    const name = `PaxHeader/${++this.paxCounter}`.slice(0, 100);
    const header = createTarHeader({
      name,
      mode: 0o644,
      uid,
      gid,
      size: BigInt(data.length),
      ...(mtime ? { mtime } : {}),
      type: 'pax',
      linkName: '',
      uname,
      gname
    });
    await this.writeChunk(header);
    await this.writeChunk(data);
    await this.writePadding(BigInt(data.length));
  }

  /** @internal */
  private async pipeData(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        throwIfAborted(this.signal);
        const { value, done } = await reader.read();
        if (done) break;
        if (value) await this.writeChunk(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** @internal */
  private async writePadding(size: bigint): Promise<void> {
    const padding = Number((BigInt(BLOCK_SIZE) - (size % BigInt(BLOCK_SIZE))) % BigInt(BLOCK_SIZE));
    if (padding > 0) {
      await this.writeChunk(new Uint8Array(padding));
    }
  }

  /** @internal */
  private async writeChunk(chunk: Uint8Array): Promise<void> {
    throwIfAborted(this.signal);
    await this.writer.write(chunk);
  }
}

function inferType(name: string, options?: TarWriterAddOptions): TarEntryType {
  if (options?.type) return options.type;
  if (name.endsWith('/')) return 'directory';
  return 'file';
}

async function resolveSource(
  source: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | undefined,
  sizeHint: bigint | undefined,
  signal?: AbortSignal
): Promise<{ size: bigint; stream?: ReadableStream<Uint8Array> }> {
  if (!source) return { size: 0n };
  if (source instanceof Uint8Array) {
    return { size: BigInt(source.length), stream: readableFromBytes(source) };
  }
  if (source instanceof ArrayBuffer) {
    const view = new Uint8Array(source);
    return { size: BigInt(view.length), stream: readableFromBytes(view) };
  }
  if (isReadableStream(source)) {
    if (sizeHint !== undefined) return { size: sizeHint, stream: source };
    const readOptions: { signal?: AbortSignal } = {};
    if (signal) readOptions.signal = signal;
    const data = await readAllBytes(source, readOptions);
    return { size: BigInt(data.length), stream: readableFromBytes(data) };
  }
  if (sizeHint !== undefined) {
    return { size: sizeHint, stream: readableFromAsyncIterable(source) };
  }
  const readOptions: { signal?: AbortSignal } = {};
  if (signal) readOptions.signal = signal;
  const data = await readAllBytes(readableFromAsyncIterable(source), readOptions);
  return { size: BigInt(data.length), stream: readableFromBytes(data) };
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof (value as ReadableStream<Uint8Array>).getReader === 'function';
}

function resolveMtime(mtime: Date | undefined, deterministic: boolean): Date {
  if (deterministic) return new Date(0);
  return mtime ?? new Date();
}

function resolveMode(mode: number | undefined, type: TarEntryType, deterministic: boolean): number {
  let resolved: number;
  if (mode !== undefined && !deterministic) {
    resolved = mode;
  } else if (type === 'directory') {
    resolved = 0o755;
  } else if (type === 'symlink') {
    resolved = 0o777;
  } else {
    resolved = 0o644;
  }
  return clampMode(resolved);
}

function clampMode(mode: number): number {
  return mode & 0o777;
}

function resolveId(id: number | undefined, deterministic: boolean): number {
  if (deterministic) return 0;
  return id ?? 0;
}

function fitName(value: string, pax: Record<string, string>, key: string): string {
  if (value.length <= 100) return value;
  pax[key] = value;
  return value.slice(0, 100);
}

function createTarHeader(options: {
  name: string;
  mode: number;
  uid: number;
  gid: number;
  size: bigint;
  mtime?: Date;
  type: TarEntryType | 'pax';
  linkName: string;
  uname: string;
  gname: string;
}): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  writeString(header, 0, 100, options.name);
  writeOctal(header, 100, 8, BigInt(options.mode));
  writeOctal(header, 108, 8, BigInt(options.uid));
  writeOctal(header, 116, 8, BigInt(options.gid));
  writeOctal(header, 124, 12, options.size);
  const mtime = options.mtime ? BigInt(Math.floor(options.mtime.getTime() / 1000)) : 0n;
  writeOctal(header, 136, 12, mtime);
  // checksum placeholder (spaces)
  for (let i = 148; i < 156; i += 1) header[i] = 0x20;
  header[156] = typeFlag(options.type);
  writeString(header, 157, 100, options.linkName);
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, options.uname);
  writeString(header, 297, 32, options.gname);

  const checksum = computeChecksum(header);
  writeChecksum(header, checksum);
  return header;
}

function typeFlag(type: TarEntryType | 'pax'): number {
  switch (type) {
    case 'file':
      return '0'.charCodeAt(0);
    case 'directory':
      return '5'.charCodeAt(0);
    case 'symlink':
      return '2'.charCodeAt(0);
    case 'link':
      return '1'.charCodeAt(0);
    case 'character':
      return '3'.charCodeAt(0);
    case 'block':
      return '4'.charCodeAt(0);
    case 'fifo':
      return '6'.charCodeAt(0);
    case 'unknown':
      return '0'.charCodeAt(0);
    case 'pax':
      return 'x'.charCodeAt(0);
    default:
      return '0'.charCodeAt(0);
  }
}

function computeChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < header.length; i += 1) {
    sum += header[i]!;
  }
  return sum;
}

function writeString(buffer: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = TEXT_ENCODER.encode(value);
  buffer.set(encoded.subarray(0, length), offset);
}

function writeOctal(buffer: Uint8Array, offset: number, length: number, value: bigint): void {
  if (!fitsInOctal(value, length)) {
    writeBase256(buffer, offset, length, value);
    return;
  }
  const text = value.toString(8).padStart(length - 1, '0');
  const encoded = TEXT_ENCODER.encode(text);
  buffer.set(encoded, offset + (length - 1 - encoded.length));
  buffer[offset + length - 1] = 0;
}

function writeChecksum(buffer: Uint8Array, value: number): void {
  const text = value.toString(8).padStart(6, '0');
  const encoded = TEXT_ENCODER.encode(text);
  buffer.set(encoded, 148);
  buffer[154] = 0;
  buffer[155] = 0x20;
}

function fitsInOctal(value: bigint, length: number): boolean {
  const max = (1n << BigInt((length - 1) * 3)) - 1n;
  return value >= 0 && value <= max;
}

function writeBase256(buffer: Uint8Array, offset: number, length: number, value: bigint): void {
  let val = value;
  for (let i = offset + length - 1; i >= offset; i -= 1) {
    buffer[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  buffer[offset] = (buffer[offset] ?? 0) | 0x80;
}

function encodePaxRecords(records: Record<string, string>): Uint8Array {
  let out = '';
  for (const [key, value] of Object.entries(records)) {
    const record = `${key}=${value}\n`;
    let length = record.length + 2;
    while (true) {
      const prefix = `${length} `;
      const total = prefix.length + record.length;
      if (total === length) {
        out += `${length} ${record}`;
        break;
      }
      length = total;
    }
  }
  return TEXT_ENCODER.encode(out);
}
