import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const CHECK = process.argv.includes('--check');

const EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-test',
  'playwright-report',
  'test/fixtures',
  'test-results',
  'specs'
]);

const TEXT_EXTS = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yaml',
  '.yml',
  '.txt',
  '.css',
  '.html'
]);

const TRIM_TRAILING = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.txt',
  '.css',
  '.html'
]);

const changed = [];

await walk(ROOT);

if (changed.length > 0) {
  if (CHECK) {
    console.error('format:check failed for:');
    for (const file of changed) console.error(`- ${file}`);
    process.exitCode = 1;
  } else {
    console.log(`format: updated ${changed.length} file(s)`);
  }
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    const rel = path.relative(ROOT, entryPath);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(rel)) continue;
      await walk(entryPath);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!TEXT_EXTS.has(ext)) continue;
    await formatFile(entryPath, rel, ext);
  }
}

async function formatFile(filePath, rel, ext) {
  const data = await readFile(filePath);
  if (data.includes(0)) return;
  const text = data.toString('utf8');
  const normalized = normalize(text, ext);
  if (normalized === text) return;
  changed.push(rel);
  if (!CHECK) {
    await writeFile(filePath, normalized, 'utf8');
  }
}

function normalize(text, ext) {
  let out = text.replace(/\r\n/g, '\n');
  if (TRIM_TRAILING.has(ext)) {
    out = out.replace(/[ \t]+$/gm, '');
  }
  if (!out.endsWith('\n')) {
    out += '\n';
  }
  return out;
}
