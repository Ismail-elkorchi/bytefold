import assert from 'node:assert/strict';
import test from 'node:test';

const MODULE_URL = new URL('../scripts/verify-pack.mjs', import.meta.url);
const SCHEMA_PATHS = [
  'schemas/audit-report.schema.json',
  'schemas/capabilities-report.schema.json',
  'schemas/detection-report.schema.json',
  'schemas/error.schema.json',
  'schemas/normalize-report.schema.json'
] as const;

type PackInfo = {
  filename: string | null;
  size: number;
  files: string[];
};

type PackModule = {
  PACK_POLICY: {
    allowExact: readonly string[];
    denyPrefixes: readonly string[];
  };
  inspectPack: (options?: { dryRun?: boolean }) => PackInfo;
  validatePack: (info: PackInfo) => void;
};

test('npm pack payload obeys allowlist and denylist policy', async () => {
  const module = (await import(MODULE_URL.href)) as PackModule;
  const info = module.inspectPack({ dryRun: true });
  const packed = new Set(info.files);

  assert.ok(packed.has('SPEC.md'));
  for (const schemaPath of SCHEMA_PATHS) {
    assert.ok(packed.has(schemaPath), `missing schema in pack payload: ${schemaPath}`);
  }

  assert.ok(!packed.has('docs/REPO_INDEX.md'));
  assert.ok(!packed.has('docs/REPO_INDEX.md.sha256'));

  assert.ok(module.PACK_POLICY.allowExact.includes('SPEC.md'));
  for (const schemaPath of SCHEMA_PATHS) {
    assert.ok(module.PACK_POLICY.allowExact.includes(schemaPath));
  }
  assert.ok(module.PACK_POLICY.denyPrefixes.includes('docs/'));

  module.validatePack(info);
});
