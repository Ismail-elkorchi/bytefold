import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { toWebWritable } from '../streams/adapters.js';

export interface Sink {
  position: bigint;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface SeekableSink extends Sink {
  writeAt(offset: bigint, chunk: Uint8Array): Promise<void>;
}

class BaseSink implements Sink {
  position: bigint = 0n;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(private readonly stream: WritableStream<Uint8Array>) {
    this.writer = stream.getWriter();
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) return;
    await this.writer.write(chunk);
    this.position += BigInt(chunk.length);
  }

  async close(): Promise<void> {
    await this.writer.close();
  }
}

export class WebWritableSink extends BaseSink {
  constructor(stream: WritableStream<Uint8Array>) {
    super(stream);
  }
}

export class NodeWritableSink extends BaseSink {
  constructor(stream: NodeJS.WritableStream) {
    super(toWebWritable(stream));
  }
}

export class FileSink implements SeekableSink {
  position: bigint = 0n;
  private readonly handlePromise: ReturnType<typeof open>;

  constructor(path: string | URL) {
    const filePath = typeof path === 'string' ? path : fileURLToPath(path);
    this.handlePromise = open(filePath, 'w');
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) return;
    const handle = await this.handlePromise;
    await handle.write(chunk, 0, chunk.length, Number(this.position));
    this.position += BigInt(chunk.length);
  }

  async writeAt(offset: bigint, chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) return;
    const handle = await this.handlePromise;
    await handle.write(chunk, 0, chunk.length, Number(offset));
  }

  async close(): Promise<void> {
    const handle = await this.handlePromise;
    await handle.close();
  }
}
