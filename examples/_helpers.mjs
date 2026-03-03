/**
 * Goal: Provide shared in-memory archive helpers for example scripts.
 * Prereqs:
 * - Run from repo root after `npm run build`.
 * Run:
 * - Imported by other example files (`node examples/run-all.mjs`).
 * Expected output:
 * - Helper exports for creating ZIP bytes and collecting writable stream chunks.
 * Safety notes:
 * - Utility module only; no network access and no persistent filesystem writes.
 */
import { createArchiveWriter } from "../dist/archive/index.js";

const encoder = new TextEncoder();

export function writableCollector() {
  const chunks = [];
  const writable = new WritableStream({
    write(chunk) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    },
  });
  return {
    writable,
    toBytes() {
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return merged;
    },
  };
}

export async function makeZipBytes(entries) {
  const collector = writableCollector();
  const writer = createArchiveWriter("zip", collector.writable);
  for (const entry of entries) {
    await writer.add(entry.name, encoder.encode(entry.content));
  }
  await writer.close();
  return collector.toBytes();
}

export async function streamToUint8Array(stream) {
  const response = new Response(stream);
  return new Uint8Array(await response.arrayBuffer());
}
