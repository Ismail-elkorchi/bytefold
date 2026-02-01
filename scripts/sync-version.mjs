import { readFileSync, writeFileSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const allowWrite = args.has('--write') || args.has('--fix');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const pkg = readJson('package.json');
const jsr = readJson('jsr.json');

if (pkg.name !== jsr.name) {
  console.error(`Name mismatch: package.json=${pkg.name} jsr.json=${jsr.name}`);
  process.exit(1);
}

if (pkg.version !== jsr.version) {
  if (allowWrite) {
    jsr.version = pkg.version;
    writeFileSync('jsr.json', `${JSON.stringify(jsr, null, 2)}\n`, 'utf8');
    console.log(`[bytefold] jsr.json version updated to ${pkg.version}`);
  } else {
    console.error(`Version mismatch: package.json=${pkg.version} jsr.json=${jsr.version}`);
    process.exit(1);
  }
}
