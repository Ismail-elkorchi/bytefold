import { spawnSync } from 'node:child_process';

const which = spawnSync('bash', ['-lc', 'command -v bun'], { encoding: 'utf-8' });
const bunPath = (which.stdout || '').trim();

if (which.status !== 0 || !bunPath) {
  console.log('[bytefold][bun] bun not found; skipping bun smoke tests.');
  process.exit(0);
}

const result = spawnSync(bunPath, ['test', './test/bun.smoke.ts'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
