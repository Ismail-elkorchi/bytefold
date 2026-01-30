import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { throwIfAborted } from '../../abort.js';
import type { RandomAccess } from '../../reader/RandomAccess.js';

export { BufferRandomAccess, HttpRandomAccess, type RandomAccess } from '../../reader/RandomAccess.js';

export class FileRandomAccess implements RandomAccess {
  private readonly handlePromise: ReturnType<typeof open>;

  constructor(private readonly path: string) {
    this.handlePromise = open(this.path, 'r');
  }

  async size(signal?: AbortSignal): Promise<bigint> {
    throwIfAborted(signal);
    const handle = await this.handlePromise;
    const stat = await handle.stat();
    throwIfAborted(signal);
    return BigInt(stat.size);
  }

  async read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);
    const handle = await this.handlePromise;
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Number(offset));
    throwIfAborted(signal);
    if (bytesRead === length) return buffer;
    return buffer.subarray(0, bytesRead);
  }

  async close(): Promise<void> {
    const handle = await this.handlePromise;
    await handle.close();
  }

  static fromPath(path: string | URL): FileRandomAccess {
    const filePath = typeof path === 'string' ? path : fileURLToPath(path);
    return new FileRandomAccess(filePath);
  }
}
