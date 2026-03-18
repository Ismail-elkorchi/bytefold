import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const CHILD_SCRIPT = String.raw`
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(process.env.BYTEFOLD_DEFLATE64_MODULE_PATH);
const { createDeflate64DecompressStream } = await import(moduleUrl.href);

function buildStoredBlock(payloadLength, isFinal) {
  const out = new Uint8Array(5 + payloadLength);
  out[0] = isFinal ? 0x01 : 0x00;
  out[1] = payloadLength & 0xff;
  out[2] = (payloadLength >>> 8) & 0xff;
  const nlen = payloadLength ^ 0xffff;
  out[3] = nlen & 0xff;
  out[4] = (nlen >>> 8) & 0xff;
  out.fill(0x41, 5);
  return out;
}

const transform = createDeflate64DecompressStream();
const writer = transform.writable.getWriter();
const reader = transform.readable.getReader();
let outputBytes = 0;
const drain = (async () => {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    outputBytes += value?.length ?? 0;
  }
})();

global.gc();
const before = process.memoryUsage();
for (let i = 0; i < 40000; i += 1) {
  await writer.write(buildStoredBlock(256, false));
}
await new Promise((resolve) => setTimeout(resolve, 0));
global.gc();
global.gc();
const mid = process.memoryUsage();
await writer.write(buildStoredBlock(0, true));
await writer.close();
await drain;
global.gc();
global.gc();
const after = process.memoryUsage();

console.log(JSON.stringify({
  beforeArrayBuffersBytes: before.arrayBuffers,
  midArrayBuffersBytes: mid.arrayBuffers,
  afterArrayBuffersBytes: after.arrayBuffers,
  outputBytes
}));
`;

test('deflate64 releases consumed input chunks during active decode', () => {
  const modulePath = path.join(process.cwd(), 'dist/compression/deflate64.js');
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', CHILD_SCRIPT], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      BYTEFOLD_DEFLATE64_MODULE_PATH: modulePath
    }
  });

  assert.equal(result.error, undefined, `spawn failed: ${result.error?.message ?? 'unknown error'}`);
  assert.equal(result.status, 0, `expected success, got status=${result.status}\n${result.stdout}\n${result.stderr}`);
  const payload = JSON.parse(result.stdout) as {
    beforeArrayBuffersBytes: number;
    midArrayBuffersBytes: number;
    afterArrayBuffersBytes: number;
    outputBytes: number;
  };

  assert.equal(payload.outputBytes, 10240000);
  assert.ok(payload.midArrayBuffersBytes <= 2 * 1024 * 1024, `expected bounded mid-stream arrayBuffers, got ${payload.midArrayBuffersBytes}`);
  assert.ok(payload.afterArrayBuffersBytes <= 1024 * 1024, `expected low retained arrayBuffers after close, got ${payload.afterArrayBuffersBytes}`);
});
