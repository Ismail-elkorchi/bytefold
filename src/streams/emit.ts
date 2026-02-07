export type EmitStableOptions = {
  transfer?: boolean;
};

type Uint8Controller =
  | TransformStreamDefaultController<Uint8Array>
  | ReadableStreamDefaultController<Uint8Array>;

export function emitStable(
  controller: Uint8Controller,
  chunk: Uint8Array,
  options: EmitStableOptions = {}
): boolean {
  if (
    options.transfer &&
    chunk.byteOffset === 0 &&
    chunk.byteLength === chunk.buffer.byteLength
  ) {
    controller.enqueue(chunk);
    return true;
  }
  const copy = new Uint8Array(chunk.byteLength);
  copy.set(chunk);
  controller.enqueue(copy);
  return false;
}
