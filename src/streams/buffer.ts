import { throwIfAborted } from '../abort.js';

export async function readAllBytes(
  stream: ReadableStream<Uint8Array>,
  options?: { signal?: AbortSignal; maxBytes?: bigint | number }
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0n;
  const maxBytes = options?.maxBytes !== undefined ? toBigInt(options.maxBytes) : undefined;

  try {
    while (true) {
      throwIfAborted(options?.signal);
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      total += BigInt(value.length);
      if (maxBytes !== undefined && total > maxBytes) {
        throw new RangeError('Stream exceeds maximum allowed size');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const output = new Uint8Array(Number(total));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function toBigInt(value: bigint | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
