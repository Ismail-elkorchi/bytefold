import type { ZipProgressEvent, ZipProgressOptions } from '../types.js';

const DEFAULT_PROGRESS_INTERVAL_MS = 50;
const DEFAULT_PROGRESS_CHUNK_INTERVAL = 16;

export interface ProgressTracker {
  update(bytesInDelta: number, bytesOutDelta: number): void;
  flush(): void;
}

export function createProgressTracker(
  options: ZipProgressOptions | undefined,
  base: Omit<ZipProgressEvent, 'bytesIn' | 'bytesOut'>
): ProgressTracker | null {
  if (!options?.onProgress) return null;
  const intervalMs = Number.isFinite(options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS)
    ? Math.max(0, Math.floor(options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS))
    : DEFAULT_PROGRESS_INTERVAL_MS;
  const chunkInterval = Number.isFinite(options.progressChunkInterval ?? DEFAULT_PROGRESS_CHUNK_INTERVAL)
    ? Math.max(1, Math.floor(options.progressChunkInterval ?? DEFAULT_PROGRESS_CHUNK_INTERVAL))
    : DEFAULT_PROGRESS_CHUNK_INTERVAL;
  return new ThrottledProgressTracker(options.onProgress, base, intervalMs, chunkInterval);
}

export function createProgressTransform(tracker: ProgressTracker | null): TransformStream<Uint8Array, Uint8Array> {
  if (!tracker) {
    return new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      }
    });
  }
  return new TransformStream({
    transform(chunk, controller) {
      tracker.update(chunk.length, chunk.length);
      controller.enqueue(chunk);
    },
    flush() {
      tracker.flush();
    }
  });
}

class ThrottledProgressTracker implements ProgressTracker {
  private bytesIn = 0n;
  private bytesOut = 0n;
  private chunksSinceEmit = 0;
  private lastEmit = 0;

  constructor(
    private readonly onProgress: (event: ZipProgressEvent) => void,
    private readonly base: Omit<ZipProgressEvent, 'bytesIn' | 'bytesOut'>,
    private readonly intervalMs: number,
    private readonly chunkInterval: number
  ) {}

  update(bytesInDelta: number, bytesOutDelta: number): void {
    this.bytesIn += BigInt(bytesInDelta);
    this.bytesOut += BigInt(bytesOutDelta);
    this.chunksSinceEmit += 1;
    const now = Date.now();
    if (this.chunksSinceEmit >= this.chunkInterval || now - this.lastEmit >= this.intervalMs) {
      this.emit(now);
    }
  }

  flush(): void {
    this.emit(Date.now());
  }

  private emit(now: number): void {
    this.lastEmit = now;
    this.chunksSinceEmit = 0;
    this.onProgress({
      ...this.base,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut
    });
  }
}
