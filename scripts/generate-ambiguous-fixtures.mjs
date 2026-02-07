import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchiveWriter, openArchive } from '../dist/index.js';

const encoder = new TextEncoder();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(repoRoot, 'test', 'fixtures', 'ambiguous');

await mkdir(fixtureRoot, { recursive: true });

const writeBytes = (name, bytes) => writeFile(path.join(fixtureRoot, name), bytes);

const tarPax = await writeArchive(
  'tar',
  [
    {
      name: `pax/${'a'.repeat(110)}.txt`,
      data: encoder.encode('long name')
    },
    {
      name: './a//b/./c.txt',
      data: encoder.encode('redundant segments')
    },
    {
      name: 'conflict',
      data: encoder.encode('file entry')
    },
    {
      name: 'conflict',
      data: new Uint8Array(),
      options: { type: 'directory' }
    },
    {
      name: 'ok.txt',
      data: encoder.encode('ok')
    }
  ],
  { tar: { deterministic: true } }
);
await writeBytes('tar-pax-longname.tar', tarPax);
await writeBytes('tar-pax-longname.norm.tar', await normalizeBytes(tarPax));

const tarDuplicates = await writeArchive(
  'tar',
  [
    { name: 'dup.txt', data: encoder.encode('first') },
    { name: 'dup.txt', data: encoder.encode('second') },
    { name: 'Readme.txt', data: encoder.encode('readme') },
    { name: 'README.TXT', data: encoder.encode('readme2') }
  ],
  { tar: { deterministic: true } }
);
await writeBytes('tar-duplicates.tar', tarDuplicates);

const tarCaseCollision = await writeArchive(
  'tar',
  [
    { name: 'Readme.txt', data: encoder.encode('readme') },
    { name: 'README.TXT', data: encoder.encode('readme2') }
  ],
  { tar: { deterministic: true } }
);
await writeBytes('tar-case-collision.tar', tarCaseCollision);

const tarLinks = await writeArchive(
  'tar',
  [
    { name: 'target.txt', data: encoder.encode('target') },
    { name: 'link', data: undefined, options: { type: 'symlink', linkName: 'target.txt' } },
    { name: 'hardlink', data: undefined, options: { type: 'link', linkName: 'target.txt' } }
  ],
  { tar: { deterministic: true } }
);
await writeBytes('tar-links.tar', tarLinks);

const tarPathTraversal = await writeArchive(
  'tar',
  [
    { name: '../evil.txt', data: encoder.encode('nope') },
    { name: '/abs.txt', data: encoder.encode('abs') },
    { name: 'C:drive.txt', data: encoder.encode('drive') }
  ],
  { tar: { deterministic: true } }
);
await writeBytes('tar-path-traversal.tar', tarPathTraversal);

const zipDuplicates = await writeArchive(
  'zip',
  [
    { name: 'dup.txt', data: encoder.encode('first') },
    { name: 'dup.txt', data: encoder.encode('second') },
    { name: 'Readme.txt', data: encoder.encode('readme') },
    { name: 'README.TXT', data: encoder.encode('readme2') },
    { name: 'a\\\\b.txt', data: encoder.encode('backslash') }
  ],
  { zip: { defaultMethod: 0 } }
);
await writeBytes('zip-duplicates.zip', zipDuplicates);

const zipCaseCollision = await writeArchive(
  'zip',
  [
    { name: 'Readme.txt', data: encoder.encode('readme') },
    { name: 'README.TXT', data: encoder.encode('readme2') }
  ],
  { zip: { defaultMethod: 0 } }
);
await writeBytes('zip-case-collision.zip', zipCaseCollision);

const zipPaths = await writeArchive(
  'zip',
  [
    { name: 'dir/', data: new Uint8Array() },
    { name: 'dir', data: encoder.encode('file') },
    { name: 'a\\\\b.txt', data: encoder.encode('backslash') },
    { name: 'a/./c.txt', data: encoder.encode('dot') }
  ],
  { zip: { defaultMethod: 0 } }
);
await writeBytes('zip-paths.zip', zipPaths);
await writeBytes('zip-paths.norm.zip', await normalizeBytes(zipPaths));

const zipPathTraversal = await writeArchive(
  'zip',
  [
    { name: '../evil.txt', data: encoder.encode('nope') },
    { name: '/abs.txt', data: encoder.encode('abs') },
    { name: 'C:\\\\drive.txt', data: encoder.encode('drive') }
  ],
  { zip: { defaultMethod: 0 } }
);
await writeBytes('zip-path-traversal.zip', zipPathTraversal);

async function writeArchive(format, entries, options) {
  const chunks = [];
  const writable = new WritableStream({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter(format, writable, options);
  for (const entry of entries) {
    const addOptions = entry.options ? { ...entry.options } : {};
    if (format === 'zip' && addOptions.mtime === undefined) {
      addOptions.mtime = new Date(0);
    }
    await writer.add(entry.name, entry.data, Object.keys(addOptions).length > 0 ? addOptions : undefined);
  }
  await writer.close();
  return concatChunks(chunks);
}

async function normalizeBytes(bytes) {
  const reader = await openArchive(bytes);
  const chunks = [];
  const writable = new WritableStream({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const normalizeToWritable = reader.normalizeToWritable?.bind(reader);
  if (!normalizeToWritable) throw new Error('normalizeToWritable missing');
  await normalizeToWritable(writable, { deterministic: true });
  return concatChunks(chunks);
}

function concatChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
