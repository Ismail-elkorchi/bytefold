import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const DOCS_CHECK_SCRIPT = new URL('../scripts/docs-check.mjs', import.meta.url);

test('docs:check excludes local meta loop directory', async () => {
  const script = await readFile(DOCS_CHECK_SCRIPT, 'utf8');
  assert.match(script, /'.bytefold_meta'/);
});
