import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SPEC = new URL('../SPEC.md', import.meta.url);

test('SPEC documents chunk immutability invariant with test links', async () => {
  const spec = await readFile(SPEC, 'utf8');
  assert.match(spec, /chunk(s)? are immutable/i);
  assert.ok(spec.includes('test/xz-aliasing.test.ts'));
  assert.ok(spec.includes('test/deflate64-aliasing.test.ts'));
});
