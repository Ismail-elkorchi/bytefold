import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');
const PACKED_SCHEMA_FILES = Object.freeze([
  'schemas/audit-report.schema.json',
  'schemas/capabilities-report.schema.json',
  'schemas/detection-report.schema.json',
  'schemas/error.schema.json',
  'schemas/normalize-report.schema.json'
]);

export const PACK_POLICY = Object.freeze({
  allowExact: Object.freeze([
    'LICENSE',
    'README.md',
    'SPEC.md',
    'package.json',
    'jsr.json',
    ...PACKED_SCHEMA_FILES
  ]),
  allowPrefixes: Object.freeze(['dist/']),
  denyPrefixes: Object.freeze([
    'docs/',
    'test/',
    'specs/',
    'bench/',
    'dist-test/',
    'node_modules/',
    'scripts/',
    'src/',
    'tools/'
  ]),
  denySubstrings: Object.freeze(['/fixtures/', '/thirdparty/', '/corpus/', '/mutation/']),
  requiredExact: Object.freeze(['LICENSE', 'README.md', 'SPEC.md', 'package.json', ...PACKED_SCHEMA_FILES]),
  requiredPrefixes: Object.freeze(['dist/'])
});

if (isEntrypoint()) {
  await runCli();
}

/**
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ filename: string | null; size: number; files: string[] }}
 */
export function inspectPack(options = {}) {
  const dryRun = options.dryRun === true;
  const command = ['pack', '--json', '--silent'];
  if (dryRun) {
    command.push('--dry-run');
  }
  const result = spawnSync('npm', command, {
    cwd: ROOT_DIR,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'npm pack failed');
  }

  const stdout = (result.stdout ?? '').trim();
  if (!stdout) {
    throw new Error('npm pack produced no output');
  }
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || !parsed[0]) {
    throw new Error('Unexpected npm pack JSON shape');
  }
  const info = parsed[0];
  const files = collectPackFiles(info);

  return {
    filename: typeof info.filename === 'string' ? info.filename : null,
    size: typeof info.size === 'number' ? info.size : 0,
    files
  };
}

/**
 * @param {{ filename: string | null; files: string[] }} info
 */
export function validatePack(info) {
  const files = [...info.files].sort((a, b) => a.localeCompare(b));
  const fileSet = new Set(files);
  const violations = [];

  const forbidden = files.filter((file) => isForbidden(file));
  if (forbidden.length > 0) {
    violations.push(`forbidden paths:\n${forbidden.map((file) => `- ${file}`).join('\n')}`);
  }

  const unexpected = files.filter((file) => !isAllowed(file));
  if (unexpected.length > 0) {
    violations.push(
      `paths outside allowlist:\n${unexpected.map((file) => `- ${file}`).join('\n')}`
    );
  }

  const missingRequiredExact = PACK_POLICY.requiredExact.filter((file) => !fileSet.has(file));
  if (missingRequiredExact.length > 0) {
    violations.push(
      `missing required files:\n${missingRequiredExact.map((file) => `- ${file}`).join('\n')}`
    );
  }

  const missingRequiredPrefixes = PACK_POLICY.requiredPrefixes.filter(
    (prefix) => !files.some((file) => file.startsWith(prefix))
  );
  if (missingRequiredPrefixes.length > 0) {
    violations.push(
      `missing required prefixes:\n${missingRequiredPrefixes.map((prefix) => `- ${prefix}`).join('\n')}`
    );
  }

  const missingExports = getExpectedExportArtifacts().filter((artifact) => !fileSet.has(artifact));
  if (missingExports.length > 0) {
    violations.push(
      `missing export artifacts:\n${missingExports.map((file) => `- ${file}`).join('\n')}`
    );
  }

  const hasDistJavascript = files.some(
    (file) => file.startsWith('dist/') && file.endsWith('.js')
  );
  if (!hasDistJavascript) {
    violations.push('dist/ does not contain runtime JavaScript output');
  }

  const hasDistTypes = files.some(
    (file) => file.startsWith('dist/') && file.endsWith('.d.ts')
  );
  if (!hasDistTypes) {
    violations.push('dist/ does not contain TypeScript declarations');
  }

  if (violations.length > 0) {
    throw new Error(`npm pack validation failed:\n${violations.join('\n\n')}`);
  }
}

async function runCli() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const info = inspectPack({ dryRun });
  try {
    validatePack(info);
    const label = info.filename ?? '(dry-run)';
    process.stdout.write(
      `[bytefold][pack] ${label} size=${info.size} bytes files=${info.files.length}\n`
    );
  } finally {
    if (!dryRun && info.filename) {
      try {
        unlinkSync(path.join(ROOT_DIR, info.filename));
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

/**
 * @param {unknown} rawInfo
 * @returns {string[]}
 */
function collectPackFiles(rawInfo) {
  if (!rawInfo || typeof rawInfo !== 'object') {
    throw new Error('Unexpected npm pack JSON entry');
  }
  const files = Array.isArray(rawInfo.files) ? rawInfo.files : [];
  const normalized = files
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const candidate = entry.path;
      return typeof candidate === 'string' ? normalizePath(candidate) : null;
    })
    .filter((value) => typeof value === 'string');
  if (normalized.length === 0) {
    throw new Error('npm pack JSON did not include file paths');
  }
  return normalized;
}

function isAllowed(file) {
  if (PACK_POLICY.allowExact.includes(file)) return true;
  return PACK_POLICY.allowPrefixes.some((prefix) => file.startsWith(prefix));
}

function isForbidden(file) {
  if (PACK_POLICY.denyPrefixes.some((prefix) => file.startsWith(prefix))) return true;
  const lower = file.toLowerCase();
  return PACK_POLICY.denySubstrings.some((segment) => lower.includes(segment));
}

function getExpectedExportArtifacts() {
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  const exportsMap = packageJson.exports ?? {};
  if (!exportsMap || typeof exportsMap !== 'object' || Array.isArray(exportsMap)) {
    throw new Error('package.json exports must be an object');
  }

  const expected = new Set([
    normalizePath(packageJson.main ?? ''),
    normalizePath(packageJson.types ?? '')
  ]);

  for (const value of Object.values(exportsMap)) {
    if (typeof value === 'string') {
      expected.add(normalizePath(value));
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (typeof value.default === 'string') expected.add(normalizePath(value.default));
    if (typeof value.types === 'string') expected.add(normalizePath(value.types));
  }

  return [...expected].filter((item) => item.length > 0).sort((a, b) => a.localeCompare(b));
}

function normalizePath(filePath) {
  return filePath.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function isEntrypoint() {
  return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}
