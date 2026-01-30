const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      if ((c & 1) !== 0) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export class Crc32 {
  private value: number = 0xffffffff;

  update(chunk: Uint8Array): void {
    let crc = this.value;
    for (let i = 0; i < chunk.length; i += 1) {
      crc = TABLE[(crc ^ chunk[i]!) & 0xff]! ^ (crc >>> 8);
    }
    this.value = crc >>> 0;
  }

  digest(): number {
    return (this.value ^ 0xffffffff) >>> 0;
  }
}

export function crc32(chunk: Uint8Array, seed = 0xffffffff): number {
  let crc = seed >>> 0;
  for (let i = 0; i < chunk.length; i += 1) {
    crc = TABLE[(crc ^ chunk[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return crc >>> 0;
}
