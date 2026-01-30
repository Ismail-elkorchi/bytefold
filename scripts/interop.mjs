import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let ZipWriter;
try {
  ({ ZipWriter } = await import('../dist/index.js'));
} catch (err) {
  console.error('[zip-next][interop] Missing dist build. Run `npm run build` first.');
  process.exit(2);
}

function which(cmd) {
  const result = spawnSync('which', [cmd], { stdio: 'ignore' });
  return result.status === 0;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  return result.status === 0;
}

const sevenZip = which('7z') ? '7z' : which('7za') ? '7za' : null;
const unzip = which('unzip') ? 'unzip' : null;

const tempDir = await mkdtemp(path.join(tmpdir(), 'zip-next-interop-'));
const aesPath = path.join(tempDir, 'aes.zip');
const zipcryptoPath = path.join(tempDir, 'zipcrypto.zip');
const password = 'zip-next';

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

  if (sevenZip) {
    console.log(`[zip-next][interop] 7z detected: ${sevenZip}`);
    const ok = run(sevenZip, ['t', `-p${password}`, aesPath]);
    console.log(`[zip-next][interop] AES -> 7z t: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) failed = true;
  } else {
    console.log('[zip-next][interop] 7z/7za not found; skipping AES test.');
  }

  if (unzip) {
    console.log('[zip-next][interop] unzip detected');
    const ok = run(unzip, ['-t', '-P', password, zipcryptoPath]);
    console.log(`[zip-next][interop] ZipCrypto -> unzip -t: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) failed = true;
  } else {
    console.log('[zip-next][interop] unzip not found; skipping ZipCrypto test.');
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
