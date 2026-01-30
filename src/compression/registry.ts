import type { ZipCompressionCodec } from './types.js';
import { DEFLATE64_CODEC, DEFLATE_CODEC, STORE_CODEC, ZSTD_CODEC } from './codecs.js';

const codecs = new Map<number, ZipCompressionCodec>();
let builtinsRegistered = false;

export function registerCompressionCodec(codec: ZipCompressionCodec): void {
  codecs.set(codec.methodId, codec);
}

export function getCompressionCodec(methodId: number): ZipCompressionCodec | undefined {
  return codecs.get(methodId);
}

export function hasCompressionCodec(methodId: number): boolean {
  return codecs.has(methodId);
}

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
