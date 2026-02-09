import assert from 'node:assert/strict';
import test from 'node:test';

const MODULE_URL = new URL('../scripts/generate-fixture-hashes.mjs', import.meta.url);

type FixtureManifestModule = {
  computeSecurityFixtureHashes: () => Promise<Record<string, string>>;
  diffSecurityFixtureManifest: (
    expectedFiles: Record<string, string>,
    actualFiles: Record<string, string>
  ) => {
    missing: string[];
    unexpected: string[];
    changed: Array<{ path: string; expected: string; actual: string }>;
  };
  readSecurityFixtureManifest: () => Promise<{ version: number; files: Record<string, string> }>;
};

test('security fixture hash manifest matches allowlisted fixture bytes', async () => {
  const module = (await import(MODULE_URL.href)) as FixtureManifestModule;
  const manifest = await module.readSecurityFixtureManifest();
  const actualFiles = await module.computeSecurityFixtureHashes();

  assert.equal(manifest.version, 1);
  const diff = module.diffSecurityFixtureManifest(manifest.files, actualFiles);
  const hasMismatch = diff.missing.length > 0 || diff.unexpected.length > 0 || diff.changed.length > 0;
  if (!hasMismatch) return;

  const details: string[] = [];
  if (diff.missing.length > 0) {
    details.push(`missing:\n- ${diff.missing.join('\n- ')}`);
  }
  if (diff.unexpected.length > 0) {
    details.push(`unexpected:\n- ${diff.unexpected.join('\n- ')}`);
  }
  if (diff.changed.length > 0) {
    details.push(
      `changed:\n${diff.changed.map((entry) => `- ${entry.path}\n  expected ${entry.expected}\n  actual   ${entry.actual}`).join('\n')}`
    );
  }

  assert.fail(`security fixture hash manifest mismatch\n${details.join('\n')}`);
});
