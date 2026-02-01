import type { ZipCompressionCodec } from './types.js';
import { DEFLATE64_CODEC, DEFLATE_CODEC, STORE_CODEC, ZSTD_CODEC } from './codecs.js';

const codecs = new Map<number, ZipCompressionCodec>();
let builtinsRegistered = false;

/** Register a custom ZIP compression codec by method id. */
export function registerCompressionCodec(codec: ZipCompressionCodec): void {
  codecs.set(codec.methodId, codec);
}

/** Look up a registered ZIP compression codec by method id. */
export function getCompressionCodec(methodId: number): ZipCompressionCodec | undefined {
  return codecs.get(methodId);
}

/** Check whether a ZIP compression codec is registered. */
export function hasCompressionCodec(methodId: number): boolean {
  return codecs.has(methodId);
}

/** List all registered ZIP compression codecs. */
export function listCompressionCodecs(): ZipCompressionCodec[] {
  return [...codecs.values()];
}

function registerBuiltins(): void {
  if (builtinsRegistered) return;
  builtinsRegistered = true;
  registerCompressionCodec(STORE_CODEC);
  registerCompressionCodec(DEFLATE_CODEC);
  registerCompressionCodec(ZSTD_CODEC);
  registerCompressionCodec(DEFLATE64_CODEC);
}

registerBuiltins();
