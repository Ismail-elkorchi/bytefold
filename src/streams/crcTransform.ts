import { Crc32 } from '../crc32.js';
import { ZipError } from '../errors.js';

export interface CrcTransformResult {
  crc32: number;
  bytes: bigint;
}

export interface CrcTransformOptions {
  expectedCrc?: number;
  expectedSize?: bigint;
  strict: boolean;
  onWarning?: (warning: { message: string }) => void;
  entryName?: string;
}

export function createCrcTransform(
  result: CrcTransformResult,
  options: CrcTransformOptions
): TransformStream<Uint8Array, Uint8Array> {
  const crc = new Crc32();
  return new TransformStream({
    transform(chunk, controller) {
      crc.update(chunk);
      result.bytes += BigInt(chunk.length);
      controller.enqueue(chunk);
    },
    flush() {
      result.crc32 = crc.digest();
      if (options.expectedCrc !== undefined && result.crc32 !== options.expectedCrc) {
        const message = `CRC32 mismatch for ${options.entryName ?? 'entry'}`;
        if (options.strict) {
          throw new ZipError('ZIP_BAD_CRC', message, { entryName: options.entryName });
        }
        options.onWarning?.({ message });
      }
      if (options.expectedSize !== undefined && result.bytes !== options.expectedSize) {
        const message = `Uncompressed size mismatch for ${options.entryName ?? 'entry'}`;
        if (options.strict) {
          throw new ZipError('ZIP_BAD_CRC', message, { entryName: options.entryName });
        }
        options.onWarning?.({ message });
      }
    }
  });
}
