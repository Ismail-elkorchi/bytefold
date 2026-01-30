import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { toWebWritable } from '../../streams/adapters.js';
import { WebWritableSink, type SeekableSink, type Sink } from '../../writer/Sink.js';

export { WebWritableSink, type SeekableSink, type Sink };

export class NodeWritableSink extends WebWritableSink {
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

export function isWebWritable(stream: WritableStream<Uint8Array> | NodeJS.WritableStream): stream is WritableStream<Uint8Array> {
  return typeof (stream as WritableStream<Uint8Array>).getWriter === 'function';
}

export function toNodeWritable(stream: WritableStream<Uint8Array> | NodeJS.WritableStream): Writable {
  if (!isWebWritable(stream)) return stream as Writable;
  return Writable.fromWeb(stream as any) as Writable;
}
