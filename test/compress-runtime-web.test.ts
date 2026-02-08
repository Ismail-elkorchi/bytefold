import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

type CapabilityProbeOutput = {
  runtime?: string;
  notes?: string[];
  algorithms?: Record<string, { compress?: boolean; decompress?: boolean; backend?: string }>;
};

test('compression capabilities report runtime=web in browser-like environment', () => {
  const result = runWebProbe([
    'globalThis.CompressionStream = class CompressionStreamStub { constructor(_format) {} };',
    'globalThis.DecompressionStream = class DecompressionStreamStub { constructor(_format) {} };'
  ]);

  assert.equal(result.runtime, 'web');
});

test('web capabilities probe constructor acceptance per algorithm and mode', () => {
  const result = runWebProbe([
    "const compressFormats = new Set(['gzip', 'deflate']);",
    "const decompressFormats = new Set(['gzip', 'zstd']);",
    [
      'globalThis.CompressionStream = class CompressionStreamStub {',
      '  constructor(format) {',
      "    if (!compressFormats.has(format)) throw new TypeError('unsupported format');",
      '  }',
      '};'
    ].join('\n'),
    [
      'globalThis.DecompressionStream = class DecompressionStreamStub {',
      '  constructor(format) {',
      "    if (!decompressFormats.has(format)) throw new TypeError('unsupported format');",
      '  }',
      '};'
    ].join('\n')
  ]);

  assert.equal(result.runtime, 'web');
  assert.deepEqual(result.algorithms?.gzip, { compress: true, decompress: true, backend: 'web' });
  assert.deepEqual(result.algorithms?.deflate, { compress: true, decompress: false, backend: 'web' });
  assert.deepEqual(result.algorithms?.['deflate-raw'], { compress: false, decompress: false, backend: 'none' });
  assert.deepEqual(result.algorithms?.brotli, { compress: false, decompress: false, backend: 'none' });
  assert.deepEqual(result.algorithms?.zstd, { compress: false, decompress: true, backend: 'web' });
  assert.deepEqual(result.algorithms?.bzip2, { compress: false, decompress: true, backend: 'pure-js' });
  assert.deepEqual(result.algorithms?.xz, { compress: false, decompress: true, backend: 'pure-js' });
});

test('web capabilities note missing constructors and keep mode-specific support truthful', () => {
  const result = runWebProbe([
    'globalThis.CompressionStream = undefined;',
    [
      'globalThis.DecompressionStream = class DecompressionStreamStub {',
      '  constructor(format) {',
      "    if (format !== 'gzip') throw new TypeError('unsupported format');",
      '  }',
      '};'
    ].join('\n')
  ]);

  assert.equal(result.runtime, 'web');
  assert.ok(result.notes?.includes('CompressionStream constructor not available in this runtime'));
  assert.deepEqual(result.algorithms?.gzip, { compress: false, decompress: true, backend: 'web' });
  assert.deepEqual(result.algorithms?.deflate, { compress: false, decompress: false, backend: 'none' });
});

function runWebProbe(setupLines: string[]): CapabilityProbeOutput {
  const script = [
    "const distUrl = new URL('./dist/compress/index.js', `file://${process.cwd()}/`).href;",
    'globalThis.Bun = undefined;',
    'globalThis.Deno = undefined;',
    'globalThis.process = undefined;',
    ...setupLines,
    'const mod = await import(distUrl);',
    'const caps = mod.getCompressionCapabilities();',
    "console.log(JSON.stringify({ runtime: caps.runtime, notes: caps.notes, algorithms: caps.algorithms }));"
  ].join('\n');

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: process.cwd()
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse((result.stdout || '').trim()) as CapabilityProbeOutput;
}
