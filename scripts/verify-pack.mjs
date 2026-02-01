import { spawnSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import path from 'node:path';

function runPack() {
  const result = spawnSync('npm', ['pack', '--json', '--silent'], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    throw new Error('npm pack failed');
  }
  const stdout = (result.stdout || '').trim();
  if (!stdout) {
    throw new Error('npm pack produced no output');
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    console.error(stdout);
    throw new Error('Failed to parse npm pack JSON output');
  }
  if (!Array.isArray(parsed) || !parsed[0]) {
    throw new Error('Unexpected npm pack JSON shape');
  }
  return parsed[0];
}

const info = runPack();
const filename = info.filename;
const files = (info.files || []).map((entry) => entry.path);
const forbiddenPrefixes = [
  'test/',
  'specs/',
  'bench/',
  'dist-test/',
  'node_modules/',
  'scripts/',
  'src/'
];
const forbiddenMatches = ['bench/results/'];
const violations = files.filter((file) => {
  if (forbiddenMatches.some((prefix) => file.startsWith(prefix))) return true;
  return forbiddenPrefixes.some((prefix) => file.startsWith(prefix));
});

if (violations.length > 0) {
  console.error('npm pack contains forbidden paths:');
  for (const file of violations) {
    console.error(`- ${file}`);
  }
  throw new Error('npm pack validation failed');
}

if (!files.some((file) => file.startsWith('dist/'))) {
  throw new Error('npm pack missing dist/ output');
}

const size = info.size ?? 0;
console.log(`[bytefold][pack] ${filename} size=${size} bytes files=${files.length}`);

if (filename) {
  const packPath = path.resolve(filename);
  try {
    unlinkSync(packPath);
  } catch {
    // ignore cleanup errors
  }
}
