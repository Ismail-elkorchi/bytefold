import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');
const JSR_JSON_PATH = path.join(ROOT_DIR, 'jsr.json');
const SNAPSHOT_PATH = path.join(ROOT_DIR, 'test/fixtures/type-surface-manifest.json');
const PACKAGE_NAME = '@ismail-elkorchi/bytefold';

if (isEntrypoint()) {
  await runCli();
}

/**
 * @param {string} [rootDir]
 * @returns {Promise<{
 *   schemaVersion: string;
 *   package: string;
 *   entrypoints: Record<string, {
 *     registries: string[];
 *     npmSpecifier: string;
 *     dtsPath: string;
 *     sha256: string;
 *     bytes: number;
 *   }>;
 * }>}
 */
export async function buildTypeSurfaceManifest(rootDir = ROOT_DIR) {
  const packageJson = await readJson(path.join(rootDir, 'package.json'));
  const jsrJson = await readJson(path.join(rootDir, 'jsr.json'));
  const entries = collectEntrypoints(packageJson, jsrJson);

  const entrypoints = {};
  for (const [entrypoint, entry] of entries) {
    const declarationRelativePath = normalizePath(entry.dtsPath);
    const declarationAbsolutePath = path.join(rootDir, declarationRelativePath);
    const declarationSource = await readFile(declarationAbsolutePath, 'utf8');
    const normalized = normalizeDeclaration(declarationSource);
    entrypoints[entrypoint] = {
      registries: [...entry.registries],
      npmSpecifier: toNpmSpecifier(entrypoint),
      dtsPath: declarationRelativePath,
      sha256: sha256(normalized),
      bytes: Buffer.byteLength(normalized, 'utf8')
    };
  }

  return {
    schemaVersion: '1',
    package: packageJson.name,
    entrypoints
  };
}

/**
 * @param {string} [rootDir]
 * @param {string} [snapshotPath]
 * @returns {Promise<void>}
 */
export async function writeTypeSurfaceSnapshot(rootDir = ROOT_DIR, snapshotPath = SNAPSHOT_PATH) {
  const manifest = await buildTypeSurfaceManifest(rootDir);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(snapshotPath, serialized, 'utf8');
}

/**
 * @param {string} [rootDir]
 * @param {string} [snapshotPath]
 * @returns {Promise<boolean>}
 */
export async function verifyTypeSurfaceSnapshot(rootDir = ROOT_DIR, snapshotPath = SNAPSHOT_PATH) {
  const actual = await buildTypeSurfaceManifest(rootDir);
  const expected = JSON.parse(await readFile(snapshotPath, 'utf8'));
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function runCli() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--write')) {
    await writeTypeSurfaceSnapshot(ROOT_DIR, SNAPSHOT_PATH);
    return;
  }

  const manifest = await buildTypeSurfaceManifest(ROOT_DIR);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * @param {Record<string, unknown>} packageJson
 * @param {Record<string, unknown>} jsrJson
 */
function collectEntrypoints(packageJson, jsrJson) {
  const entries = new Map();
  const npmExports = packageJson.exports ?? {};
  if (!isObject(npmExports)) {
    throw new Error('package.json exports must be an object');
  }

  for (const [entrypoint, value] of Object.entries(npmExports)) {
    if (!isObject(value) || typeof value.types !== 'string') {
      throw new Error(`package.json export "${entrypoint}" is missing a "types" path`);
    }
    const existing = entries.get(entrypoint) ?? { registries: new Set(), dtsPath: '' };
    existing.registries.add('npm');
    existing.dtsPath = normalizePath(value.types);
    entries.set(entrypoint, existing);
  }

  const jsrExports = jsrJson.exports ?? {};
  if (!isObject(jsrExports)) {
    throw new Error('jsr.json exports must be an object');
  }
  for (const entrypoint of Object.keys(jsrExports)) {
    const existing = entries.get(entrypoint) ?? { registries: new Set(), dtsPath: deriveTypesPath(entrypoint) };
    existing.registries.add('jsr');
    if (!existing.dtsPath) {
      existing.dtsPath = deriveTypesPath(entrypoint);
    }
    entries.set(entrypoint, existing);
  }

  const sorted = [...entries.entries()].sort(([left], [right]) => left.localeCompare(right));
  return new Map(
    sorted.map(([entrypoint, value]) => {
      return [
        entrypoint,
        {
          registries: [...value.registries].sort(),
          dtsPath: value.dtsPath
        }
      ];
    })
  );
}

function deriveTypesPath(entrypoint) {
  if (entrypoint === '.' || entrypoint === './') {
    return 'dist/index.d.ts';
  }
  const normalized = normalizeEntrypoint(entrypoint);
  return `dist/${normalized}/index.d.ts`;
}

function normalizeEntrypoint(entrypoint) {
  if (entrypoint.startsWith('./')) {
    return entrypoint.slice(2);
  }
  return entrypoint;
}

function normalizePath(value) {
  return value.replace(/^\.\//u, '').replace(/\\/gu, '/');
}

function normalizeDeclaration(text) {
  const unix = text.replace(/\r\n/gu, '\n');
  const withoutMapReference = unix.replace(/^\/\/# sourceMappingURL=.*\n?/gmu, '');
  const withoutTrailingWhitespace = withoutMapReference.replace(/[ \t]+$/gmu, '');
  return `${withoutTrailingWhitespace.trimEnd()}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function toNpmSpecifier(entrypoint) {
  if (entrypoint === '.' || entrypoint === './') return PACKAGE_NAME;
  if (entrypoint.startsWith('./')) return `${PACKAGE_NAME}/${entrypoint.slice(2)}`;
  return entrypoint;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEntrypoint() {
  return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}
