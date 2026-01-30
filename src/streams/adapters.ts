import { Readable, Writable } from 'node:stream';

export function isWebReadable(stream: unknown): stream is ReadableStream<Uint8Array> {
  return !!stream && typeof (stream as ReadableStream<Uint8Array>).getReader === 'function';
}

export function isWebWritable(stream: unknown): stream is WritableStream<Uint8Array> {
  return !!stream && typeof (stream as WritableStream<Uint8Array>).getWriter === 'function';
}

export function toWebReadable(stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  if (isWebReadable(stream)) return stream;
  return Readable.toWeb(stream as any) as ReadableStream<Uint8Array>;
}

export function toWebWritable(stream: WritableStream<Uint8Array> | NodeJS.WritableStream): WritableStream<Uint8Array> {
  if (isWebWritable(stream)) return stream;
  return Writable.toWeb(stream as any) as WritableStream<Uint8Array>;
}

export function toNodeReadable(stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream): Readable {
  if (!isWebReadable(stream)) return stream as Readable;
  return Readable.fromWeb(stream as any) as Readable;
}

export function toNodeWritable(stream: WritableStream<Uint8Array> | NodeJS.WritableStream): Writable {
  if (!isWebWritable(stream)) return stream as Writable;
  return Writable.fromWeb(stream as any) as Writable;
}

export function readableFromBytes(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  });
}

export function readableFromAsyncIterable(iterable: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel() {
      if (typeof iterator.return === 'function') {
        await iterator.return();
      }
    }
  });
}
