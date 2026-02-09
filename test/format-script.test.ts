import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const FORMAT_SCRIPT = new URL('../scripts/format.mjs', import.meta.url);

test('format script excludes Playwright artifact directories', async () => {
  const script = await readFile(FORMAT_SCRIPT, 'utf8');
  assert.match(script, /'playwright-report'/);
  assert.match(script, /'test-results'/);
});
