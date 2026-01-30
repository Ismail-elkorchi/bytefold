import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { encodeUtf8 } from '../binary.js';
import { ZipError } from '../errors.js';
import { AesCtr } from './ctr.js';

export type AesStrength = 128 | 192 | 256;

export interface AesKeys {
  encKey: Uint8Array;
  authKey: Uint8Array;
  pwv: Uint8Array;
}

export function getAesSaltLength(strength: AesStrength): number {
  switch (strength) {
    case 128:
      return 8;
    case 192:
      return 12;
    case 256:
      return 16;
    default: {
      const exhaustive: never = strength;
      return exhaustive;
    }
  }
}

export function getAesStrengthCode(strength: AesStrength): 1 | 2 | 3 {
  switch (strength) {
    case 128:
      return 1;
    case 192:
      return 2;
    case 256:
      return 3;
    default: {
      const exhaustive: never = strength;
      return exhaustive;
    }
  }
}

export function strengthFromCode(code: number): AesStrength | undefined {
  switch (code) {
    case 1:
      return 128;
    case 2:
      return 192;
    case 3:
      return 256;
    default:
      return undefined;
  }
}

export function deriveAesKeys(password: string, salt: Uint8Array, strength: AesStrength): AesKeys {
  const keyLen = strength / 8;
  const derived = pbkdf2Sync(encodeUtf8(password), salt, 1000, keyLen * 2 + 2, 'sha1');
  const bytes = new Uint8Array(derived.buffer, derived.byteOffset, derived.byteLength);
  return {
    encKey: bytes.subarray(0, keyLen),
    authKey: bytes.subarray(keyLen, keyLen * 2),
    pwv: bytes.subarray(keyLen * 2, keyLen * 2 + 2)
  };
}

export function generateSalt(strength: AesStrength): Uint8Array {
  return new Uint8Array(randomBytes(getAesSaltLength(strength)));
}

export function passwordVerifierMatches(derived: Uint8Array, stored: Uint8Array): boolean {
  if (derived.length !== stored.length) return false;
  return timingSafeEqual(derived, stored);
}

export function createAesEncryptionTransform(
  encKey: Uint8Array,
  authKey: Uint8Array,
  result: { authCode?: Uint8Array }
): TransformStream<Uint8Array, Uint8Array> {
  const ctr = new AesCtr(encKey);
  const hmac = createHmac('sha1', authKey);
  return new TransformStream({
    transform(chunk, controller) {
      const encrypted = ctr.update(chunk);
      hmac.update(encrypted);
      controller.enqueue(encrypted);
    },
    flush() {
      const digest = hmac.digest();
      result.authCode = new Uint8Array(digest.subarray(0, 10));
      ctr.finalize();
    }
  });
}

export function createAesDecryptionTransform(
  encKey: Uint8Array,
  authKey: Uint8Array,
  expectedAuthCode: Uint8Array,
  entryName?: string
): TransformStream<Uint8Array, Uint8Array> {
  const ctr = new AesCtr(encKey);
  const hmac = createHmac('sha1', authKey);
  return new TransformStream({
    transform(chunk, controller) {
      hmac.update(chunk);
      const plain = ctr.update(chunk);
      controller.enqueue(plain);
    },
    flush() {
      const digest = hmac.digest();
      const actual = digest.subarray(0, 10);
      if (actual.length !== expectedAuthCode.length || !timingSafeEqual(actual, expectedAuthCode)) {
        throw new ZipError('ZIP_AUTH_FAILED', 'AES authentication failed', { entryName });
      }
      ctr.finalize();
    }
  });
}
