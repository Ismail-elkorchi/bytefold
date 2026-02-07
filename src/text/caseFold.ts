import { CASE_FOLDING_MAP } from '../generated/unicodeCaseFolding.js';

/** Full Unicode case folding (C + F), excluding Turkic mappings. */
export function caseFoldFull(input: string): string {
  if (input.length === 0) return input;
  let out = '';
  for (const ch of input) {
    const codePoint = ch.codePointAt(0);
    if (codePoint === undefined) continue;
    const mapped = CASE_FOLDING_MAP.get(codePoint);
    out += mapped ?? ch;
  }
  return out;
}

/** Normalize path-like entry names for collision detection. */
export function normalizePathForCollision(inputName: string, isDirectory?: boolean): string | null {
  if (inputName.includes('\u0000')) return null;
  const normalized = inputName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.some((part) => part === '..')) return null;
  let name = parts.join('/');
  const directory = isDirectory ?? normalized.endsWith('/');
  if (directory && !name.endsWith('/')) {
    name = name.length > 0 ? `${name}/` : '';
  }
  if (name.length === 0) return null;
  return name;
}

/** Canonical collision key: path normalization -> NFC -> full case fold -> NFC. */
export function toCollisionKey(inputName: string, isDirectory?: boolean): string {
  const normalized = normalizePathForCollision(inputName, isDirectory);
  if (!normalized) {
    throw new Error('Invalid entry name for collision key');
  }
  const nfc = normalized.normalize('NFC');
  const folded = caseFoldFull(nfc);
  return folded.normalize('NFC');
}
