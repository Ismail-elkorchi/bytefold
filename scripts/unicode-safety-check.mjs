import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();

const DANGEROUS_CODEPOINTS = new Map([
  [0x061c, 'ARABIC LETTER MARK'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0x206a, 'INHIBIT SYMMETRIC SWAPPING'],
  [0x206b, 'ACTIVATE SYMMETRIC SWAPPING'],
  [0x206c, 'INHIBIT ARABIC FORM SHAPING'],
  [0x206d, 'ACTIVATE ARABIC FORM SHAPING'],
  [0x206e, 'NATIONAL DIGIT SHAPES'],
  [0x206f, 'NOMINAL DIGIT SHAPES']
]);

const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.a',
  '.bin',
  '.bmp',
  '.br',
  '.bz2',
  '.class',
  '.dll',
  '.dylib',
  '.eot',
  '.gif',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mp3',
  '.mp4',
  '.otf',
  '.pdf',
  '.png',
  '.so',
  '.tar',
  '.ttf',
  '.wasm',
  '.webm',
  '.woff',
  '.woff2',
  '.xz',
  '.zip',
  '.zst'
]);

const SKIP_DIRECTORIES = new Set(['.bytefold_meta', '.git', 'node_modules']);

const options = parseArgs(process.argv.slice(2));
const files = options.roots.length > 0 ? await listFilesUnderRoots(options.roots) : listGitTrackedFiles();
const findings = [];

for (const filePath of files) {
  const relativePath = normalizeDisplayPath(filePath);
  if (shouldSkipFile(relativePath)) continue;
  const bytes = await readFile(filePath);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  findings.push(...scanText(text, relativePath));
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(
      `[unicode-safety] ${finding.file}:${finding.line}:${finding.column} ${finding.codePoint} ${finding.name}`
    );
  }
  console.error(`[unicode-safety] Found ${findings.length} dangerous Unicode directional control character(s).`);
  process.exitCode = 1;
}

function parseArgs(args) {
  const roots = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--root') {
      const value = args[i + 1];
      if (!value) {
        throw new Error('Missing value for --root');
      }
      roots.push(path.resolve(ROOT, value));
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { roots };
}

function printHelp() {
  process.stdout.write(
    [
      'Usage:',
      '  node scripts/unicode-safety-check.mjs',
      '  node scripts/unicode-safety-check.mjs --root <path> [--root <path> ...]',
      '',
      'Defaults to scanning git-tracked text files in the repository.'
    ].join('\n')
  );
}

function listGitTrackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Failed to list tracked files');
  }
  return (result.stdout || '')
    .split('\0')
    .filter(Boolean)
    .map((relative) => path.resolve(ROOT, relative))
    .filter((filePath) => !filePath.includes(`${path.sep}.bytefold_meta${path.sep}`));
}

async function listFilesUnderRoots(roots) {
  const output = [];
  for (const root of roots) {
    await walk(root, output);
  }
  return output;
}

async function walk(dir, output) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await walk(fullPath, output);
      continue;
    }
    if (!entry.isFile()) continue;
    output.push(fullPath);
  }
}

function shouldSkipFile(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  if (relativePath.startsWith('test/fixtures/')) {
    // Fixtures may contain binary corpus bytes. Text fixtures are still scanned.
    if (BINARY_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function normalizeDisplayPath(filePath) {
  const relative = path.relative(ROOT, filePath);
  if (!relative || relative.startsWith('..')) {
    return filePath;
  }
  return relative.split(path.sep).join('/');
}

function scanText(text, file) {
  const output = [];
  let line = 1;
  let column = 1;
  for (let offset = 0; offset < text.length; ) {
    const value = text.codePointAt(offset);
    if (value === undefined) break;
    const width = value > 0xffff ? 2 : 1;
    if (DANGEROUS_CODEPOINTS.has(value)) {
      output.push({
        file,
        line,
        column,
        codePoint: `U+${value.toString(16).toUpperCase().padStart(4, '0')}`,
        name: DANGEROUS_CODEPOINTS.get(value)
      });
    }

    const chunk = text.slice(offset, offset + width);
    if (chunk === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    offset += width;
  }
  return output;
}
