import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIRD_PARTY_ROOT = fileURLToPath(new URL('../test/fixtures/thirdparty/', import.meta.url));
const MAX_FILE_BYTES = 128 * 1024;
const MAX_DIR_BYTES = 512 * 1024;
const MAX_DIR_FILES = 16;

test('third-party fixtures declare provenance and stay bounded', async () => {
  const entries = await readdir(THIRD_PARTY_ROOT, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  assert.ok(dirs.length > 0, 'no third-party fixture directories found');

  for (const dir of dirs) {
    const dirPath = path.join(THIRD_PARTY_ROOT, dir.name);
    const thirdPartyPath = path.join(dirPath, 'THIRD_PARTY.md');
    const text = await readFile(thirdPartyPath, 'utf8');
    assert.match(text, /https?:\/\//, `${dir.name} THIRD_PARTY.md missing origin URL`);
    const licenseMatch =
      text.match(/SPDX\s*`?([a-z0-9.-]+)`?/i) ?? text.match(/License\s*:\s*([^\n]+)/i);
    assert.ok(licenseMatch, `${dir.name} THIRD_PARTY.md missing license identifier`);

    const files = await readdir(dirPath, { withFileTypes: true });
    let totalBytes = 0;
    let fileCount = 0;
    for (const file of files) {
      if (!file.isFile()) continue;
      if (file.name === 'THIRD_PARTY.md') continue;
      const filePath = path.join(dirPath, file.name);
      const info = await stat(filePath);
      totalBytes += info.size;
      fileCount += 1;
      assert.ok(info.size <= MAX_FILE_BYTES, `${file.name} exceeds ${MAX_FILE_BYTES} bytes`);
    }
    assert.ok(fileCount > 0, `${dir.name} missing fixture files`);
    assert.ok(fileCount <= MAX_DIR_FILES, `${dir.name} exceeds ${MAX_DIR_FILES} fixture files`);
    assert.ok(totalBytes <= MAX_DIR_BYTES, `${dir.name} exceeds ${MAX_DIR_BYTES} bytes total`);
  }
});
