import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('compression capabilities report runtime=web in browser-like environment', () => {
  const script = [
    "const distUrl = new URL('./dist/compress/index.js', `file://${process.cwd()}/`).href;",
    'delete globalThis.process;',
    'globalThis.CompressionStream = class CompressionStreamStub {};',
    'globalThis.DecompressionStream = class DecompressionStreamStub {};',
    'const mod = await import(distUrl);',
    'const caps = mod.getCompressionCapabilities();',
    "console.log(JSON.stringify({ runtime: caps.runtime }));"
  ].join('\n');

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: process.cwd()
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse((result.stdout || '').trim()) as { runtime?: string };
  assert.equal(parsed.runtime, 'web');
});
