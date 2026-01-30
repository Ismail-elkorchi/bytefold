import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { ZipReader, ZipWriter } from 'archive-shield/node/zip';
import type { ZipProgressEvent } from 'archive-shield/node/zip';

async function writeZip(entries: Array<{ name: string; data: Uint8Array; method?: 0 | 8 | 93 }>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    }
  });
  const writer = ZipWriter.toWritable(writable);
  for (const entry of entries) {
    await writer.add(entry.name, entry.data, { method: entry.method ?? 0 });
  }
  await writer.close();
  return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function makeTempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `archive-shield-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

test('progress events are monotonic and tagged per entry', async () => {
  const data = new TextEncoder().encode('progress');
  const zip = await writeZip([{ name: 'progress.txt', data, method: 0 }]);
  const reader = await ZipReader.fromUint8Array(zip);
  const entry = reader.entries()[0]!;
  const events: ZipProgressEvent[] = [];

  const stream = await reader.open(entry, {
    onProgress: (evt) => {
      if (evt.kind === 'extract') {
        events.push(evt);
      }
    }
  });
  await new Response(stream).arrayBuffer();

  assert.ok(events.length > 0);
  assert.ok(events.every((evt) => evt.entryName === entry.name));
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(events[i]!.bytesOut !== undefined);
    assert.ok(events[i - 1]!.bytesOut !== undefined);
    assert.ok(events[i]!.bytesOut! >= events[i - 1]!.bytesOut!);
    assert.equal(events[i]!.entryName, entry.name);
  }
  await reader.close();
});

test('abort signal stops extractAll mid-stream', async () => {
  const data = new Uint8Array(5 * 1024 * 1024);
  data.fill(0x61);
  const zip = await writeZip([{ name: 'big.bin', data, method: 0 }]);
  const reader = await ZipReader.fromUint8Array(zip);
  const dir = await makeTempDir();
  const controller = new AbortController();
  let aborted = false;

  await assert.rejects(async () => {
    await reader.extractAll(dir, {
      signal: controller.signal,
      onProgress: (evt) => {
        if (evt.kind !== 'extract') return;
        if (!aborted && evt.bytesOut && evt.bytesOut >= 256n * 1024n) {
          aborted = true;
          controller.abort();
        }
      }
    });
  }, (err: unknown) => {
    if (!err || typeof err !== 'object') return false;
    return (err as { name?: string }).name === 'AbortError';
  });

  await reader.close();
  await rm(dir, { recursive: true, force: true });
});
