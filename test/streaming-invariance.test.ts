import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDecompressor } from '@ismail-elkorchi/bytefold/compress';

const FIXTURE_ROOT = new URL('../test/fixtures/', import.meta.url);
const EXPECTED_ROOT = new URL('../test/fixtures/expected/', import.meta.url);
const encoder = new TextEncoder();

type Fixture = {
  name: string;
  algorithm: 'gzip' | 'bzip2' | 'xz';
  expected: Uint8Array;
  strategies?: string[];
};

test('streaming decompression is invariant to input chunking', async () => {
  const fixtures: Fixture[] = [
    {
      name: 'hello.txt.gz',
      algorithm: 'gzip',
      expected: new Uint8Array(await readFile(new URL('hello.txt', EXPECTED_ROOT)))
    },
    {
      name: 'concat.bz2',
      algorithm: 'bzip2',
      expected: encoder.encode('hello bzip2\nhello bzip2\n')
    },
    {
      name: 'hello.txt.xz',
      algorithm: 'xz',
      expected: encoder.encode('hello from bytefold\n')
    },
    {
      name: 'xz-bcj/x86.xz',
      algorithm: 'xz',
      expected: new Uint8Array(await readFile(new URL('xz-bcj-x86.bin', EXPECTED_ROOT)))
    },
    {
      name: 'xz-vli/vli-uncompressed-128.xz',
      algorithm: 'xz',
      expected: new Uint8Array(await readFile(new URL('xz-vli/vli-uncompressed-128.bin', FIXTURE_ROOT))),
      strategies: ['bytes', 'burst']
    }
  ];

  for (const fixture of fixtures) {
    const input = new Uint8Array(await readFile(new URL(fixture.name, FIXTURE_ROOT)));
    const strategies = buildChunkStrategies(input.length).filter((strategy) =>
      fixture.strategies ? fixture.strategies.includes(strategy.name) : true
    );
    let baseline: Uint8Array | null = null;

    for (const strategy of strategies) {
      const output = await decompressWithChunks(fixture.algorithm, input, strategy.sizes);
      assert.deepEqual(output, fixture.expected, `${fixture.name} output mismatch (${strategy.name})`);
      if (!baseline) {
        baseline = output;
      } else {
        assert.deepEqual(output, baseline, `${fixture.name} chunking mismatch (${strategy.name})`);
      }
    }
  }
});

type ChunkStrategy = { name: string; sizes: number[] };

function buildChunkStrategies(total: number): ChunkStrategy[] {
  const plans: Array<{ name: string; seed: number; min: number; max: number }> = [
    { name: 'single', seed: 0x1, min: total, max: total },
    { name: 'bytes', seed: 0x2, min: 1, max: 1 },
    { name: 'tiny', seed: 0x1234, min: 1, max: 7 },
    { name: 'small', seed: 0x9e3779b9, min: 1, max: 31 },
    { name: 'medium', seed: 0xdeadbeef, min: 1, max: 128 },
    { name: 'burst', seed: 0xa5a5a5a5, min: 1, max: 512 }
  ];
  return plans.map((plan) => ({
    name: plan.name,
    sizes: splitByRng(total, xorshift32(plan.seed), plan.min, plan.max)
  }));
}

function xorshift32(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x >>>= 0;
    x ^= x << 5;
    x >>>= 0;
    return x >>> 0;
  };
}

function splitByRng(total: number, rng: () => number, min: number, max: number): number[] {
  const sizes: number[] = [];
  const clampedMin = Math.max(1, Math.floor(min));
  const clampedMax = Math.max(clampedMin, Math.floor(max));
  let remaining = total;
  while (remaining > 0) {
    const span = clampedMax - clampedMin + 1;
    const next = clampedMin + (span > 1 ? rng() % span : 0);
    const size = Math.min(remaining, next);
    sizes.push(size);
    remaining -= size;
  }
  return sizes;
}

async function decompressWithChunks(
  algorithm: 'gzip' | 'bzip2' | 'xz',
  input: Uint8Array,
  sizes: number[]
): Promise<Uint8Array> {
  const readable = chunkReadable(input, sizes);
  const transform = createDecompressor({ algorithm });
  const stream = readable.pipeThrough(transform);
  return collectStable(stream);
}

function chunkReadable(input: Uint8Array, sizes: number[]): ReadableStream<Uint8Array> {
  let offset = 0;
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= input.length) {
        controller.close();
        return;
      }
      const size = sizes[index] ?? (input.length - offset);
      index += 1;
      const end = Math.min(input.length, offset + size);
      controller.enqueue(input.subarray(offset, end));
      offset = end;
    }
  });
}

async function collectStable(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const snapshots: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      const snapshot = new Uint8Array(value.length);
      snapshot.set(value);
      snapshots.push(snapshot);
    }
  } finally {
    reader.releaseLock();
  }
  for (let i = 0; i < chunks.length; i += 1) {
    assert.deepEqual(chunks[i], snapshots[i], 'output chunk mutated after enqueue');
  }
  return concatBytes(chunks);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
