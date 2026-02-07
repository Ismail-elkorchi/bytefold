import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const REQUIRED_KEYS = ['role', 'audience', 'source_of_truth', 'update_triggers'];
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-test', 'test/fixtures']);

const missing = [];

await walk(ROOT);

if (missing.length > 0) {
  console.error('docs:check failed for:');
  for (const item of missing) {
    console.error(`- ${item}`);
  }
  process.exitCode = 1;
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
    if (path.extname(entry.name) !== '.md') continue;
    await checkFile(entryPath, rel);
  }
}

async function checkFile(filePath, rel) {
  const data = await readFile(filePath);
  if (data.includes(0)) return;
  const text = data.toString('utf8').replace(/\r\n/g, '\n');
  const frontmatter = extractFrontmatter(text);
  if (!frontmatter) {
    missing.push(`${rel} (missing frontmatter)`);
    return;
  }
  for (const key of REQUIRED_KEYS) {
    if (!frontmatter.has(key)) {
      missing.push(`${rel} (missing ${key})`);
      return;
    }
  }
}

function extractFrontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end === -1) return null;
  const body = text.slice(4, end).trim();
  const keys = new Set();
  for (const line of body.split('\n')) {
    const match = line.match(/^([a-zA-Z0-9_]+):/);
    if (match) keys.add(match[1]);
  }
  return keys;
}
