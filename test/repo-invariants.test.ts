import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);

test('runtime dependencies remain zero', async () => {
  const pkgText = await readFile(new URL('package.json', ROOT), 'utf8');
  const pkg = JSON.parse(pkgText) as {
    type?: string;
    engines?: { node?: string };
    dependencies?: Record<string, string>;
  };
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.engines?.node?.startsWith('>=24'));
});

test('TypeScript strict mode remains enabled', async () => {
  const tsconfigText = await readFile(new URL('tsconfig.json', ROOT), 'utf8');
  const tsconfig = JSON.parse(tsconfigText) as { compilerOptions?: { strict?: boolean } };
  assert.equal(tsconfig.compilerOptions?.strict, true);
});

test('default entrypoints avoid node:* imports at module evaluation', async () => {
  const entrypoints = [
    'src/index.ts',
    'src/archive/index.ts',
    'src/compress/index.ts',
    'src/zip/index.ts',
    'src/tar/index.ts',
    'src/deno/index.ts',
    'src/bun/index.ts',
    'src/web/index.ts',
    'mod.ts',
    'archive/mod.ts',
    'compress/mod.ts',
    'zip/mod.ts',
    'tar/mod.ts',
    'deno/mod.ts',
    'bun/mod.ts',
    'web/mod.ts'
  ];
  const importNode = /^\s*import\s+.*from\s+['"]node:/m;
  for (const file of entrypoints) {
    const text = await readFile(new URL(file, ROOT), 'utf8');
    assert.ok(!importNode.test(text), `${file} imports node:*`);
  }
});
