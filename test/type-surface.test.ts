import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const MODULE_URL = new URL('../scripts/type-surface-manifest.mjs', import.meta.url);
const SNAPSHOT = new URL('../test/fixtures/type-surface-manifest.json', import.meta.url);

type TypeSurfaceManifest = {
  schemaVersion: string;
  package: string;
  entrypoints: Record<
    string,
    {
      registries: string[];
      npmSpecifier: string;
      dtsPath: string;
      sha256: string;
      bytes: number;
    }
  >;
};

type TypeSurfaceModule = {
  buildTypeSurfaceManifest: () => Promise<TypeSurfaceManifest>;
};

test('public TypeScript declaration surface matches snapshot', async () => {
  const module = (await import(MODULE_URL.href)) as TypeSurfaceModule;
  const actual = await module.buildTypeSurfaceManifest();
  const expected = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as TypeSurfaceManifest;

  assert.deepEqual(
    actual,
    expected,
    [
      'Type-surface snapshot mismatch.',
      'If this is intentional, update the snapshot with:',
      '  node ./scripts/type-surface-manifest.mjs --write',
      'and add a migration entry in MIGRATIONS.md (required even for 0.x).'
    ].join('\n')
  );
});
