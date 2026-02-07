import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIRECTORY = fileURLToPath(new URL('../', import.meta.url));
const MODULE_URL = new URL('../scripts/dump-context.mjs', import.meta.url);
const MAX_REPO_INDEX_BYTES = 250 * 1024;

type ContextModule = {
  generateRepoIndexMarkdown: (rootDir?: string) => Promise<string>;
  writeRepositoryIndex: (rootDir?: string) => Promise<{ bytes: number; path: string }>;
};

async function loadContextModule(): Promise<ContextModule> {
  return (await import(MODULE_URL.href)) as ContextModule;
}

test('context index generation is deterministic and bounded', async () => {
  const { generateRepoIndexMarkdown } = await loadContextModule();
  const first = await generateRepoIndexMarkdown(ROOT_DIRECTORY);
  const second = await generateRepoIndexMarkdown(ROOT_DIRECTORY);

  assert.equal(first, second);
  assert.ok(Buffer.byteLength(first, 'utf8') <= MAX_REPO_INDEX_BYTES);
});

test('context index writes markdown + sha256 companion deterministically', async () => {
  const { writeRepositoryIndex } = await loadContextModule();

  await writeRepositoryIndex(ROOT_DIRECTORY);
  const indexPath = path.join(ROOT_DIRECTORY, 'docs/REPO_INDEX.md');
  const shaPath = `${indexPath}.sha256`;

  await writeRepositoryIndex(ROOT_DIRECTORY);
  const settledIndex = await readFile(indexPath, 'utf8');
  const settledSha = await readFile(shaPath, 'utf8');

  await writeRepositoryIndex(ROOT_DIRECTORY);
  const stableIndex = await readFile(indexPath, 'utf8');
  const stableSha = await readFile(shaPath, 'utf8');

  assert.equal(settledIndex, stableIndex);
  assert.equal(settledSha, stableSha);
  assert.match(stableSha, /^[a-f0-9]{64}  REPO_INDEX\.md\n$/);
});
