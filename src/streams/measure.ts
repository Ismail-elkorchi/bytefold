export interface MeasureResult {
  bytes: bigint;
}

export function createMeasureTransform(result: MeasureResult): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      result.bytes += BigInt(chunk.length);
      controller.enqueue(chunk);
    }
  });
}
