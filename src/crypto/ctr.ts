import { createCipheriv } from 'node:crypto';

export const AES_BLOCK_SIZE = 16;

export class AesCtr {
  private readonly cipher: ReturnType<typeof createCipheriv>;
  private readonly counter: Uint8Array;
  private keystream = new Uint8Array(AES_BLOCK_SIZE);
  private keystreamPos = AES_BLOCK_SIZE;

  constructor(key: Uint8Array, counter?: Uint8Array) {
    if (counter && counter.length !== AES_BLOCK_SIZE) {
      throw new RangeError('AES-CTR counter must be 16 bytes');
    }
    this.counter = counter ? new Uint8Array(counter) : defaultCounter();
    const algo = `aes-${key.length * 8}-ecb` as const;
    const cipher = createCipheriv(algo, key, null);
    cipher.setAutoPadding(false);
    this.cipher = cipher;
  }

  update(input: Uint8Array): Uint8Array {
    if (input.length === 0) return input;
    const output = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      if (this.keystreamPos >= AES_BLOCK_SIZE) {
        const block = this.cipher.update(this.counter);
        if (block.length !== AES_BLOCK_SIZE) {
          throw new Error('AES-ECB produced invalid block length');
        }
        this.keystream = new Uint8Array(block);
        this.keystreamPos = 0;
        incrementCounterLE(this.counter);
      }
      output[i] = input[i]! ^ this.keystream[this.keystreamPos]!;
      this.keystreamPos += 1;
    }
    return output;
  }

  finalize(): void {
    // Ensure the cipher state is finalized for completeness.
    this.cipher.final();
  }
}

function defaultCounter(): Uint8Array {
  const counter = new Uint8Array(AES_BLOCK_SIZE);
  // WinZip/7-Zip AES CTR uses a 128-bit little-endian counter starting at 1.
  counter[0] = 1;
  return counter;
}

function incrementCounterLE(counter: Uint8Array): void {
  for (let i = 0; i < counter.length; i += 1) {
    const next = (counter[i]! + 1) & 0xff;
    counter[i] = next;
    if (next !== 0) return;
  }
}
