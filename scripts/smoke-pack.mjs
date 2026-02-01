import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) process.stdout.write(result.stdout);
    throw new Error(`${cmd} ${args.join(' ')} failed`);
  }
  return result.stdout?.trim() ?? '';
}

function packArtifact() {
  const output = run('npm', ['pack', '--json', '--silent']);
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || !parsed[0]) {
    throw new Error('Unexpected npm pack JSON output');
  }
  return parsed[0].filename;
}

const tgz = packArtifact();
const packPath = path.resolve(tgz);
const tempDir = mkdtempSync(path.join(tmpdir(), 'bytefold-pack-'));

try {
  run('npm', ['init', '-y'], { cwd: tempDir });
  run('npm', ['install', '--silent', packPath], { cwd: tempDir });

  const smokePath = path.join(tempDir, 'smoke.mjs');
  const script = `import { readFile } from 'node:fs/promises';
import path from 'node:path';

const pkgRoot = path.join(process.cwd(), 'node_modules', '@ismail-elkorchi', 'bytefold');
const entryPath = path.join(pkgRoot, 'dist', 'index.js');
const source = await readFile(entryPath, 'utf8');
if (/from\\s+['\"]node:/.test(source) || /import\\s+['\"]node:/.test(source)) {
  throw new Error('default entrypoint imports node:*');
}

await import('@ismail-elkorchi/bytefold');
await import('@ismail-elkorchi/bytefold/zip');
await import('@ismail-elkorchi/bytefold/tar');
await import('@ismail-elkorchi/bytefold/compress');
`;
  writeFileSync(smokePath, script, 'utf8');
  run('node', [smokePath], { cwd: tempDir, stdio: 'inherit' });
} finally {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
  try {
    unlinkSync(packPath);
  } catch {
    // ignore cleanup errors
  }
}
