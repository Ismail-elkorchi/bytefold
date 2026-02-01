const POLY = 0xc96c5795d7870f42n;
const TABLE = (() => {
  const table = new BigUint64Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = BigInt(i);
    for (let k = 0; k < 8; k += 1) {
      if ((crc & 1n) !== 0n) {
        crc = POLY ^ (crc >> 1n);
      } else {
        crc >>= 1n;
      }
    }
    table[i] = crc;
  }
  return table;
})();

export class Crc64 {
  private value = 0xffffffffffffffffn;

  update(chunk: Uint8Array): void {
    let crc = this.value;
    for (let i = 0; i < chunk.length; i += 1) {
      const idx = Number((crc ^ BigInt(chunk[i]!)) & 0xffn);
      crc = TABLE[idx]! ^ (crc >> 8n);
    }
    this.value = crc;
  }

  digest(): bigint {
    return this.value ^ 0xffffffffffffffffn;
  }
}
