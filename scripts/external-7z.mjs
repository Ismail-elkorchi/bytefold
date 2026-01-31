import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let ZipWriter;
let listWith7z;
let extractWith7z;
let ExternalToolError;

try {
  ({ ZipWriter } = await import('../dist/node/zip/index.js'));
  ({ listWith7z, extractWith7z, ExternalToolError } = await import('../dist/node/external/index.js'));
} catch {
  console.error('[bytefold][external-7z] Missing dist build. Run `npm run build` first.');
  process.exit(2);
}

const tempDir = await mkdtemp(path.join(tmpdir(), 'bytefold-7z-'));
const archivePath = path.join(tempDir, 'sample.zip');
const extractDir = path.join(tempDir, 'out');

let failed = false;
let skipped = false;

try {
  const writer = await ZipWriter.toFile(archivePath);
  await writer.add('hello.txt', new TextEncoder().encode('hello 7z'));
  await writer.close();

  const result = await listWith7z(archivePath);

  const names = result.entries.map((entry) => entry.path);
  if (!names.includes('hello.txt')) {
    console.error('[bytefold][external-7z] listWith7z missing hello.txt');
    failed = true;
  }

  await mkdir(extractDir, { recursive: true });
  await extractWith7z(archivePath, extractDir);
  const extracted = await readFile(path.join(extractDir, 'hello.txt'));
  const text = new TextDecoder().decode(extracted);
  if (text !== 'hello 7z') {
    console.error('[bytefold][external-7z] extractWith7z content mismatch');
    failed = true;
  }
} catch (err) {
  if (err instanceof ExternalToolError && err.code === 'EXTERNAL_TOOL_MISSING') {
    console.log('[bytefold][external-7z] 7z not found; skipping.');
    skipped = true;
  }
  if (!skipped) {
    console.error('[bytefold][external-7z] failed:', err);
    failed = true;
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

if (skipped) {
  process.exit(0);
}
process.exit(failed ? 1 : 0);
