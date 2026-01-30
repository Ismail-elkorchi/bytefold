export function isWebReadable(stream: unknown): stream is ReadableStream<Uint8Array> {
  return !!stream && typeof (stream as ReadableStream<Uint8Array>).getReader === 'function';
}

export function isWebWritable(stream: unknown): stream is WritableStream<Uint8Array> {
  return !!stream && typeof (stream as WritableStream<Uint8Array>).getWriter === 'function';
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
