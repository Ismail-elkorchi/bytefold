import { ZipError } from '../errors.js';
import type { ZipWarning } from '../errors.js';
import { throwIfAborted } from '../abort.js';
import type { ZipLimits } from '../types.js';

export interface LimitTotals {
  totalUncompressed: bigint;
}

export interface LimitTransformOptions {
  entryName: string;
  compressedSize: bigint;
  limits: Required<ZipLimits>;
  strict: boolean;
  totals?: LimitTotals;
  onWarning?: (warning: ZipWarning) => void;
  signal?: AbortSignal;
}

export function createLimitTransform(options: LimitTransformOptions): TransformStream<Uint8Array, Uint8Array> {
  let bytesOut = 0n;
  let ratioWarned = false;
  return new TransformStream({
    transform(chunk, controller) {
      if (options.signal) {
        throwIfAborted(options.signal);
      }
      const delta = BigInt(chunk.length);
      bytesOut += delta;
      if (bytesOut > options.limits.maxUncompressedEntryBytes) {
        throw new ZipError('ZIP_LIMIT_EXCEEDED', 'Entry exceeds max uncompressed size', {
          entryName: options.entryName
        });
      }
      if (options.totals) {
        options.totals.totalUncompressed += delta;
        if (options.totals.totalUncompressed > options.limits.maxTotalUncompressedBytes) {
          throw new ZipError('ZIP_LIMIT_EXCEEDED', 'Total uncompressed size exceeds limit');
        }
      }
      if (!ratioWarned && options.compressedSize > 0n) {
        const ratio = Number(bytesOut) / Number(options.compressedSize);
        if (!Number.isFinite(ratio) || ratio > options.limits.maxCompressionRatio) {
          const message = 'Compression ratio exceeds safety limit';
          if (options.strict) {
            throw new ZipError('ZIP_LIMIT_EXCEEDED', message, { entryName: options.entryName });
          }
          ratioWarned = true;
          options.onWarning?.({ code: 'ZIP_LIMIT_EXCEEDED', message, entryName: options.entryName });
        }
      }
      controller.enqueue(chunk);
    }
  });
}
