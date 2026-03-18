import { readAllBytes } from './buffer.js';

export type InputByteLimits = {
  maxInputBytes?: bigint | number;
  maxTotalDecompressedBytes?: bigint | number;
  maxTotalUncompressedBytes?: bigint | number;
};

export function resolveInputMaxBytes(limits?: InputByteLimits): bigint | number | undefined {
  if (limits?.maxInputBytes !== undefined) {
    return limits.maxInputBytes;
  }
  if (limits?.maxTotalDecompressedBytes !== undefined) {
    return limits.maxTotalDecompressedBytes;
  }
  if (limits?.maxTotalUncompressedBytes !== undefined) {
    return limits.maxTotalUncompressedBytes;
  }
  return undefined;
}

export async function readResponseBytes(
  response: Response,
  options?: { signal?: AbortSignal; maxBytes?: bigint | number }
): Promise<Uint8Array> {
  const maxBytes = options?.maxBytes;
  if (maxBytes !== undefined) {
    const contentLength = response.headers.get('content-length');
    if (contentLength && /^\d+$/u.test(contentLength)) {
      if (BigInt(contentLength) > toBigInt(maxBytes)) {
        throw new RangeError('Stream exceeds maximum allowed size');
      }
    }
  }
  const body = response.body;
  if (!body) return new Uint8Array(0);
  return readAllBytes(body, {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {})
  });
}

function toBigInt(value: bigint | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
