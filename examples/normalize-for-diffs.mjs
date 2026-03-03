/**
 * Goal: Normalize archive content deterministically for diff-friendly outputs.
 * Prereqs:
 * - Run from repo root after `npm run build`.
 * Run:
 * - `node examples/normalize-for-diffs.mjs`
 * Expected output:
 * - JSON object with `{ ok: true, reportOk: true, outputBytes, warnings, errors }`.
 * Safety notes:
 * - Uses in-memory fixtures and writable collectors only.
 */
import { openArchive } from "../dist/index.js";
import { makeZipBytes, writableCollector } from "./_helpers.mjs";

export async function run() {
  const inputBytes = await makeZipBytes([
    { name: "b/file-b.txt", content: "beta" },
    { name: "a/file-a.txt", content: "alpha" },
  ]);

  const reader = await openArchive(inputBytes, { profile: "strict" });
  if (!reader.normalizeToWritable) {
    throw new Error("normalizeToWritable is unavailable for this format.");
  }

  const collector = writableCollector();
  const report = await reader.normalizeToWritable(collector.writable, {
    isDeterministic: true,
  });
  const normalizedBytes = collector.toBytes();

  const payload = {
    ok: true,
    reportOk: report.ok,
    outputBytes: normalizedBytes.byteLength,
    warnings: report.summary.warnings,
    errors: report.summary.errors,
  };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run();
}
