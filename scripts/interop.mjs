import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

let ZipWriter;
let TarWriter;
let createCompressTransform;
try {
  ({ ZipWriter } = await import('../dist/node/zip/index.js'));
  ({ TarWriter } = await import('../dist/tar/index.js'));
  ({ createCompressTransform } = await import('../dist/compression/streams.js'));
} catch (err) {
  console.error('[archive-shield][interop] Missing dist build. Run `npm run build` first.');
  process.exit(2);
}

function hasTool(cmd) {
  const result = spawnSync('bash', ['-lc', `command -v ${cmd}`], { stdio: 'ignore' });
  return result.status === 0;
}

function run(cmd, args, label) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  const ok = result.status === 0;
  if (label) {
    console.log(`[archive-shield][interop] ${label}: ${ok ? 'PASS' : 'FAIL'}`);
  }
  return ok;
}

function version(cmd, args) {
  spawnSync(cmd, args, { stdio: 'inherit' });
}

const sevenZip = hasTool('7z') ? '7z' : hasTool('7za') ? '7za' : null;
const unzip = hasTool('unzip') ? 'unzip' : null;
const zip = hasTool('zip') ? 'zip' : null;
const bsdtar = hasTool('bsdtar') ? 'bsdtar' : null;
const tar = hasTool('tar') ? 'tar' : null;
const gzip = hasTool('gzip') ? 'gzip' : null;
const zstd = hasTool('zstd') ? 'zstd' : null;

const missing = [];
if (!sevenZip) missing.push('7z');
if (!unzip) missing.push('unzip');
if (!zip) missing.push('zip');
if (!bsdtar) missing.push('bsdtar');
if (!tar) missing.push('tar');
if (!gzip) missing.push('gzip');
if (!zstd) missing.push('zstd');

const tempDir = await mkdtemp(path.join(tmpdir(), 'archive-shield-interop-'));
const aesPath = path.join(tempDir, 'aes.zip');
const zipcryptoPath = path.join(tempDir, 'zipcrypto.zip');
const plainZipPath = path.join(tempDir, 'plain.zip');
const tarPath = path.join(tempDir, 'sample.tar');
const tgzPath = path.join(tempDir, 'sample.tgz');
const zstPath = path.join(tempDir, 'sample.zst');
const password = 'archive-shield';

let failed = false;

try {
  const aesWriter = await ZipWriter.toFile(aesPath, {
    encryption: { type: 'aes', password, strength: 256, vendorVersion: 2 }
  });
  await aesWriter.add('aes.txt', new TextEncoder().encode('aes interop'));
  await aesWriter.close();

  const zipcryptoWriter = await ZipWriter.toFile(zipcryptoPath, {
    encryption: { type: 'zipcrypto', password }
  });
  await zipcryptoWriter.add('zipcrypto.txt', new TextEncoder().encode('zipcrypto interop'));
  await zipcryptoWriter.close();

  const plainWriter = await ZipWriter.toFile(plainZipPath);
  await plainWriter.add('plain.txt', new TextEncoder().encode('plain interop'));
  await plainWriter.close();

  // tar
  const tarWritable = Writable.toWeb(createWriteStream(tarPath));
  const tarWriter = TarWriter.toWritable(tarWritable);
  await tarWriter.add('tar.txt', new TextEncoder().encode('tar interop'));
  await tarWriter.close();

  // tgz
  const tarChunks = [];
  const memWritable = new WritableStream({
    write(chunk) {
      tarChunks.push(chunk);
    }
  });
  const tarWriterMem = TarWriter.toWritable(memWritable);
  await tarWriterMem.add('tgz.txt', new TextEncoder().encode('tgz interop'));
  await tarWriterMem.close();
  const tarBytes = concatChunks(tarChunks);
  const gzStream = new ReadableStream({
    start(controller) {
      controller.enqueue(tarBytes);
      controller.close();
    }
  }).pipeThrough(new CompressionStream('gzip'));
  const gzBytes = await collect(gzStream);
  await BunWrite(tgzPath, gzBytes);

  // zstd sample
  let zstdAvailable = false;
  if (typeof createCompressTransform === 'function') {
    try {
      const zstdStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('zstd interop'));
          controller.close();
        }
      }).pipeThrough(await createCompressTransform({ algorithm: 'zstd' }));
      const zstdBytes = await collect(zstdStream);
      await BunWrite(zstPath, zstdBytes);
      zstdAvailable = true;
    } catch {
      zstdAvailable = false;
    }
  }

  if (sevenZip) {
    console.log(`[archive-shield][interop] ${sevenZip} detected`);
    version(sevenZip, ['i']);
    const ok = run(sevenZip, ['t', `-p${password}`, aesPath], 'AES -> 7z t');
    if (!ok) failed = true;
  }

  if (unzip) {
    console.log('[archive-shield][interop] unzip detected');
    version(unzip, ['-v']);
    const ok = run(unzip, ['-t', '-P', password, zipcryptoPath], 'ZipCrypto -> unzip -t');
    if (!ok) failed = true;
  }

  if (zip) {
    console.log('[archive-shield][interop] zip detected');
    version(zip, ['-v']);
    const ok = run(zip, ['-T', plainZipPath], 'zip -T (plain zip)');
    if (!ok) failed = true;
  }

  if (bsdtar) {
    console.log('[archive-shield][interop] bsdtar detected');
    version(bsdtar, ['--version']);
    const ok = run(bsdtar, ['-tf', tarPath], 'bsdtar -tf (tar)');
    if (!ok) failed = true;
    const okTgz = run(bsdtar, ['-tzf', tgzPath], 'bsdtar -tzf (tgz)');
    if (!okTgz) failed = true;
  }

  if (tar) {
    console.log('[archive-shield][interop] tar detected');
    version(tar, ['--version']);
    const ok = run(tar, ['-tf', tarPath], 'tar -tf (tar)');
    if (!ok) failed = true;
    const okTgz = run(tar, ['-tzf', tgzPath], 'tar -tzf (tgz)');
    if (!okTgz) failed = true;
  }

  if (gzip) {
    console.log('[archive-shield][interop] gzip detected');
    version(gzip, ['--version']);
    const ok = run(gzip, ['-t', tgzPath], 'gzip -t (tgz)');
    if (!ok) failed = true;
  }

  if (zstd) {
    console.log('[archive-shield][interop] zstd detected');
    version(zstd, ['--version']);
    if (zstdAvailable) {
      const ok = run(zstd, ['-t', zstPath], 'zstd -t (sample)');
      if (!ok) failed = true;
    } else {
      console.log('[archive-shield][interop] zstd CLI present but Node zstd backend unavailable; skipping sample validation.');
    }
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

if (missing.length > 0) {
  console.log(`\n[archive-shield][interop] Missing tools: ${missing.join(', ')}`);
  console.log('[archive-shield][interop] Install (Debian/Ubuntu):');
  console.log('  sudo apt-get install -y p7zip-full unzip zip libarchive-tools tar gzip zstd');
}

process.exit(failed ? 1 : 0);

async function collect(stream) {
  const reader = stream.getReader();
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
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

async function BunWrite(filePath, data) {
  if (typeof Bun !== 'undefined' && Bun.write) {
    await Bun.write(filePath, data);
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(filePath);
    stream.on('error', reject);
    stream.on('finish', resolve);
    stream.end(data);
  });
}
