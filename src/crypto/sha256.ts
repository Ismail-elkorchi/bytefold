const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export class Sha256 {
  private state = new Uint32Array(8);
  private buffer = new Uint8Array(64);
  private bufferLength = 0;
  private bytesLow = 0;
  private bytesHigh = 0;
  private finished = false;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.state[0] = 0x6a09e667;
    this.state[1] = 0xbb67ae85;
    this.state[2] = 0x3c6ef372;
    this.state[3] = 0xa54ff53a;
    this.state[4] = 0x510e527f;
    this.state[5] = 0x9b05688c;
    this.state[6] = 0x1f83d9ab;
    this.state[7] = 0x5be0cd19;
    this.bufferLength = 0;
    this.bytesLow = 0;
    this.bytesHigh = 0;
    this.finished = false;
  }

  update(data: Uint8Array): void {
    if (this.finished) {
      throw new Error('SHA-256: cannot update after digest');
    }
    let offset = 0;
    this.addBytes(data.length);
    while (offset < data.length) {
      const space = 64 - this.bufferLength;
      const take = Math.min(space, data.length - offset);
      this.buffer.set(data.subarray(offset, offset + take), this.bufferLength);
      this.bufferLength += take;
      offset += take;
      if (this.bufferLength === 64) {
        this.processChunk(this.buffer);
        this.bufferLength = 0;
      }
    }
  }

  digestBytes(): Uint8Array {
    if (this.finished) {
      return this.serializeState();
    }
    this.finished = true;
    const buffer = this.buffer;
    let length = this.bufferLength;
    buffer[length++] = 0x80;
    if (length > 56) {
      buffer.fill(0, length, 64);
      this.processChunk(buffer);
      length = 0;
    }
    buffer.fill(0, length, 56);
    const bitsLow = (this.bytesLow << 3) >>> 0;
    const bitsHigh = ((this.bytesHigh << 3) | (this.bytesLow >>> 29)) >>> 0;
    buffer[56] = (bitsHigh >>> 24) & 0xff;
    buffer[57] = (bitsHigh >>> 16) & 0xff;
    buffer[58] = (bitsHigh >>> 8) & 0xff;
    buffer[59] = bitsHigh & 0xff;
    buffer[60] = (bitsLow >>> 24) & 0xff;
    buffer[61] = (bitsLow >>> 16) & 0xff;
    buffer[62] = (bitsLow >>> 8) & 0xff;
    buffer[63] = bitsLow & 0xff;
    this.processChunk(buffer);
    return this.serializeState();
  }

  private serializeState(): Uint8Array {
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i += 1) {
      const word = this.state[i]!;
      const base = i * 4;
      out[base] = (word >>> 24) & 0xff;
      out[base + 1] = (word >>> 16) & 0xff;
      out[base + 2] = (word >>> 8) & 0xff;
      out[base + 3] = word & 0xff;
    }
    return out;
  }

  private addBytes(length: number): void {
    const low = (this.bytesLow + length) >>> 0;
    if (low < this.bytesLow) {
      this.bytesHigh = (this.bytesHigh + 1) >>> 0;
    }
    this.bytesLow = low;
    this.bytesHigh = (this.bytesHigh + Math.floor(length / 0x100000000)) >>> 0;
  }

  private processChunk(chunk: Uint8Array): void {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i += 1) {
      const base = i * 4;
      w[i] =
        (chunk[base]! << 24) |
        (chunk[base + 1]! << 16) |
        (chunk[base + 2]! << 8) |
        chunk[base + 3]!;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0;
    this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0;
    this.state[7] = (this.state[7]! + h) >>> 0;
  }
}

function rotr(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}
