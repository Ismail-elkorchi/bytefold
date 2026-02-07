import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCaseFoldingSource } from './generate-unicode-casefold.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(repoRoot, 'src', 'generated', 'unicodeCaseFolding.ts');

const expected = await generateCaseFoldingSource();
let actual = '';
try {
  actual = await readFile(outputPath, 'utf8');
} catch {
  throw new Error('Generated case folding table is missing. Run scripts/generate-unicode-casefold.mjs');
}
if (actual !== expected) {
  throw new Error('Generated case folding table is out of date. Run scripts/generate-unicode-casefold.mjs');
}
