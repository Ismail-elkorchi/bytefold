import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const README = new URL('../README.md', import.meta.url);
const SECURITY = new URL('../SECURITY.md', import.meta.url);
const SPEC = new URL('../SPEC.md', import.meta.url);

test('public docs warn that ZIP password support is compatibility-only', async () => {
  const docs = await Promise.all([
    ['README.md', README] as const,
    ['SECURITY.md', SECURITY] as const,
    ['SPEC.md', SPEC] as const
  ].map(async ([name, url]) => [name, await readFile(url, 'utf8')] as const));

  for (const [name, text] of docs) {
    assert.match(text, /compatibility/i, `${name} must mention compatibility`);
    assert.match(text, /confidentiality guarantee/i, `${name} must mention the confidentiality limit`);
    assert.match(text, /ZipCrypto/i, `${name} must mention ZipCrypto weakness`);
  }
});
