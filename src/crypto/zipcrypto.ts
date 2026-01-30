import { randomBytes } from 'node:crypto';
import { encodeUtf8 } from '../binary.js';

export interface ZipCryptoKeys {
  key0: number;
  key1: number;
  key2: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function createZipCryptoHeader(
  password: string,
  options: { checkByte: number; checkWord?: number }
): { header: Uint8Array; keys: ZipCryptoKeys } {
  const plain = new Uint8Array(randomBytes(12));
  if (options.checkWord !== undefined) {
    plain[10] = options.checkWord & 0xff;
    plain[11] = (options.checkWord >>> 8) & 0xff;
  } else {
    plain[11] = options.checkByte & 0xff;
  }
  return encryptZipCryptoHeader(password, plain);
}

export function encryptZipCryptoHeader(
  password: string,
  plainHeader: Uint8Array
): { header: Uint8Array; keys: ZipCryptoKeys } {
  const keys = initKeys(encodeUtf8(password));
  const encrypted = new Uint8Array(plainHeader.length);
  for (let i = 0; i < plainHeader.length; i += 1) {
    const plain = plainHeader[i]!;
    const cipherByte = plain ^ decryptByte(keys);
    updateKeys(keys, plain);
    encrypted[i] = cipherByte;
  }
  return { header: encrypted, keys };
}

export function decryptZipCryptoHeader(
  password: string,
  encryptedHeader: Uint8Array
): { header: Uint8Array; keys: ZipCryptoKeys } {
  const keys = initKeys(encodeUtf8(password));
  const header = new Uint8Array(encryptedHeader.length);
  for (let i = 0; i < encryptedHeader.length; i += 1) {
    const cipher = encryptedHeader[i]!;
    const plain = cipher ^ decryptByte(keys);
    updateKeys(keys, plain);
    header[i] = plain;
  }
  return { header, keys };
}

export function createZipCryptoEncryptTransform(
  keys: ZipCryptoKeys
): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      const out = new Uint8Array(chunk.length);
      for (let i = 0; i < chunk.length; i += 1) {
        const plain = chunk[i]!;
        const cipher = plain ^ decryptByte(keys);
        updateKeys(keys, plain);
        out[i] = cipher;
      }
      controller.enqueue(out);
    }
  });
}

export function createZipCryptoDecryptTransform(
  keys: ZipCryptoKeys
): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      const out = new Uint8Array(chunk.length);
      for (let i = 0; i < chunk.length; i += 1) {
        const cipher = chunk[i]!;
        const plain = cipher ^ decryptByte(keys);
        updateKeys(keys, plain);
        out[i] = plain;
      }
      controller.enqueue(out);
    }
  });
}

function initKeys(password: Uint8Array): ZipCryptoKeys {
  const keys: ZipCryptoKeys = {
    key0: 0x12345678,
    key1: 0x23456789,
    key2: 0x34567890
  };
  for (let i = 0; i < password.length; i += 1) {
    updateKeys(keys, password[i]!);
  }
  return keys;
}

function updateKeys(keys: ZipCryptoKeys, byte: number): void {
  keys.key0 = crc32Update(keys.key0, byte);
  keys.key1 = (keys.key1 + (keys.key0 & 0xff)) >>> 0;
  keys.key1 = (Math.imul(keys.key1, 134775813) + 1) >>> 0;
  keys.key2 = crc32Update(keys.key2, keys.key1 >>> 24);
}

function decryptByte(keys: ZipCryptoKeys): number {
  const temp = (keys.key2 | 2) >>> 0;
  return (Math.imul(temp, temp ^ 1) >>> 8) & 0xff;
}

function crc32Update(crc: number, byte: number): number {
  return CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
}
