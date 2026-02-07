import test from 'node:test';
import assert from 'node:assert/strict';

const MODULE_URL = new URL('../scripts/web-check.mjs', import.meta.url);

type WebCheckModule = {
  runWebCheck: () => Promise<{ bytes: number; sha256: string }>;
};

test('web bundle check succeeds and is deterministic', async () => {
  const module = (await import(MODULE_URL.href)) as WebCheckModule;
  const first = await module.runWebCheck();
  const second = await module.runWebCheck();

  assert.ok(first.bytes > 0, 'web bundle output is empty');
  assert.equal(first.sha256, second.sha256, 'web bundle hash is not deterministic');
});
