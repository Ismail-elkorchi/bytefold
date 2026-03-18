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

export async function throwIfResponseContentLengthExceedsLimit(
  response: Response,
  maxBytes?: bigint | number
): Promise<void> {
  if (maxBytes === undefined) {
    return;
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/u.test(contentLength)) {
    if (BigInt(contentLength) > toBigInt(maxBytes)) {
      await response.body?.cancel().catch(() => {});
      throw new RangeError('Stream exceeds maximum allowed size');
    }
  }
}

export async function readResponseBytes(
  response: Response,
  options?: { signal?: AbortSignal; maxBytes?: bigint | number }
): Promise<Uint8Array> {
  const maxBytes = options?.maxBytes;
  await throwIfResponseContentLengthExceedsLimit(response, maxBytes);
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
