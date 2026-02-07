import { spawnSync } from 'node:child_process';

const which = spawnSync('bash', ['-lc', 'command -v deno'], { encoding: 'utf-8' });
const denoPath = (which.stdout || '').trim();

if (which.status !== 0 || !denoPath) {
  console.log('[bytefold][deno] deno not found; skipping deno smoke tests.');
  process.exit(0);
}

const result = spawnSync(
  denoPath,
  ['test', '--allow-read', '--allow-write', '--allow-net=127.0.0.1,localhost', 'test/deno.smoke.ts'],
  { stdio: 'inherit' }
);
process.exit(result.status ?? 1);
