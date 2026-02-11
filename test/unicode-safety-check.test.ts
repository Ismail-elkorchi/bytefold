import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const CHECK_SCRIPT_PATH = new URL('../scripts/unicode-safety-check.mjs', import.meta.url).pathname;

test('unicode safety scanner fails on Trojan Source bidi controls and reports location', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'bytefold-unicode-safety-'));
  const suspiciousFile = path.join(tempRoot, 'suspicious.ts');
  const safeFile = path.join(tempRoot, 'safe.ts');

  try {
    await writeFile(safeFile, 'export const ok = true;\n', 'utf8');
    await writeFile(
      suspiciousFile,
      `export const text = "safe${String.fromCodePoint(0x202e)}unsafe";\n`,
      'utf8'
    );

    const result = spawnSync(process.execPath, [CHECK_SCRIPT_PATH, '--root', tempRoot], {
      cwd: ROOT.pathname,
      encoding: 'utf8'
    });

    assert.equal(result.status, 1, `expected failure, got status=${result.status}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /unicode-safety/);
    assert.match(result.stderr, /U\+202E/);
    assert.match(result.stderr, /RIGHT-TO-LEFT OVERRIDE/);
    assert.match(result.stderr, /suspicious\.ts:1:/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('unicode safety scanner passes for safe text', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'bytefold-unicode-safe-'));
  const sourceFile = path.join(tempRoot, 'source.ts');
  try {
    await writeFile(sourceFile, 'export const ok = "hello";\n', 'utf8');

    const result = spawnSync(process.execPath, [CHECK_SCRIPT_PATH, '--root', tempRoot], {
      cwd: ROOT.pathname,
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, `unexpected failure\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr.trim(), '');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('check pipeline includes unicode safety gate', async () => {
  const pkgText = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
  const checkScript = pkg.scripts?.check ?? '';
  assert.match(checkScript, /\bnpm run unicode:check\b/);
});
