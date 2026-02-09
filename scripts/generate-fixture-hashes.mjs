import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIRECTORY = fileURLToPath(new URL('../', import.meta.url));
const MANIFEST_RELATIVE_PATH = 'test/fixtures/security-fixture-hashes.json';
const MANIFEST_PATH = path.join(ROOT_DIRECTORY, MANIFEST_RELATIVE_PATH);

const EXPLICIT_FIXTURE_FILES = [
  'test/fixtures/gzip-fhcrc-bad.gz',
  'test/fixtures/gzip-fhcrc-ok.gz',
  'test/fixtures/gzip-header-options.gz',
  'test/fixtures/xz-check-sha256.xz'
];

const FIXTURE_DIRECTORIES = [
  'test/fixtures/thirdparty',
  'test/fixtures/xz-utils',
  'test/fixtures/zip-preflight'
];

const EXCLUDED_EXTENSIONS = new Set(['.md', '.sha256']);

export async function computeSecurityFixtureHashes(rootDirectory = ROOT_DIRECTORY) {
  const files = await listSecurityFixtureFiles(rootDirectory);
  const entries = [];
  for (const relativePath of files) {
    const absolutePath = path.join(rootDirectory, relativePath);
    const bytes = await readFile(absolutePath);
    entries.push([toPosixPath(relativePath), createHash('sha256').update(bytes).digest('hex')]);
  }
  return Object.fromEntries(entries);
}

export async function listSecurityFixtureFiles(rootDirectory = ROOT_DIRECTORY) {
  const files = new Set(EXPLICIT_FIXTURE_FILES);
  for (const relativeDirectory of FIXTURE_DIRECTORIES) {
    const absoluteDirectory = path.join(rootDirectory, relativeDirectory);
    await collectFilesUnderDirectory(absoluteDirectory, files, rootDirectory);
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

export function formatSecurityFixtureManifest(files) {
  return `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
}

export async function readSecurityFixtureManifest(rootDirectory = ROOT_DIRECTORY) {
  const raw = await readFile(path.join(rootDirectory, MANIFEST_RELATIVE_PATH), 'utf8');
  return JSON.parse(raw);
}

export function diffSecurityFixtureManifest(expectedFiles, actualFiles) {
  const expectedPaths = Object.keys(expectedFiles).sort((left, right) => left.localeCompare(right));
  const actualPaths = Object.keys(actualFiles).sort((left, right) => left.localeCompare(right));

  const missing = expectedPaths.filter((path_) => !(path_ in actualFiles));
  const unexpected = actualPaths.filter((path_) => !(path_ in expectedFiles));
  const changed = expectedPaths
    .filter((path_) => path_ in actualFiles && expectedFiles[path_] !== actualFiles[path_])
    .map((path_) => ({ path: path_, expected: expectedFiles[path_], actual: actualFiles[path_] }));

  return { missing, unexpected, changed };
}

async function collectFilesUnderDirectory(absoluteDirectory, files, rootDirectory) {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      await collectFilesUnderDirectory(absolutePath, files, rootDirectory);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const relativePath = path.relative(rootDirectory, absolutePath);
    files.add(toPosixPath(relativePath));
  }
}

function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

async function main() {
  const computedFiles = await computeSecurityFixtureHashes(ROOT_DIRECTORY);
  const nextManifest = formatSecurityFixtureManifest(computedFiles);
  if (process.argv.includes('--check')) {
    const currentManifest = await readSecurityFixtureManifest(ROOT_DIRECTORY);
    const diff = diffSecurityFixtureManifest(currentManifest.files ?? {}, computedFiles);
    if (diff.missing.length === 0 && diff.unexpected.length === 0 && diff.changed.length === 0) {
      process.stdout.write('[bytefold][fixture-hashes] manifest up to date\n');
      return;
    }
    process.stderr.write('[bytefold][fixture-hashes] manifest mismatch detected\n');
    if (diff.missing.length > 0) {
      process.stderr.write(`missing:\n- ${diff.missing.join('\n- ')}\n`);
    }
    if (diff.unexpected.length > 0) {
      process.stderr.write(`unexpected:\n- ${diff.unexpected.join('\n- ')}\n`);
    }
    if (diff.changed.length > 0) {
      process.stderr.write('changed:\n');
      for (const entry of diff.changed) {
        process.stderr.write(`- ${entry.path}\n`);
        process.stderr.write(`  expected ${entry.expected}\n`);
        process.stderr.write(`  actual   ${entry.actual}\n`);
      }
    }
    process.exitCode = 1;
    return;
  }

  await writeFile(MANIFEST_PATH, nextManifest, 'utf8');
  process.stdout.write(`[bytefold][fixture-hashes] wrote ${MANIFEST_RELATIVE_PATH}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
