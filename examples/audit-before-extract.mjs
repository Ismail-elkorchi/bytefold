/**
 * Goal: Show audit-first archive handling before streaming entry payloads.
 * Prereqs:
 * - Run from repo root after `npm run build`.
 * Run:
 * - `node examples/audit-before-extract.mjs`
 * Expected output:
 * - JSON object with `{ ok: true, auditOk: true, extracted }`.
 * Safety notes:
 * - Operates on in-memory fixtures only; no network access.
 */
import { openArchive } from "../dist/index.js";
import { makeZipBytes, streamToUint8Array } from "./_helpers.mjs";

export async function run() {
  const bytes = await makeZipBytes([
    { name: "safe/file-a.txt", content: "alpha" },
    { name: "safe/file-b.txt", content: "beta" },
  ]);

  const reader = await openArchive(bytes, { profile: "agent" });
  const report = await reader.audit({ profile: "agent" });
  if (!report.ok) {
    throw new Error("Expected audit to pass in fixture example.");
  }
  await reader.assertSafe({ profile: "agent" });

  const extracted = [];
  for await (const entry of reader.entries()) {
    if (entry.isDirectory || entry.isSymlink) continue;
    const contentBytes = await streamToUint8Array(await entry.open());
    extracted.push({
      name: entry.name,
      bytes: contentBytes.length,
    });
  }

  const payload = {
    ok: true,
    auditOk: report.ok,
    extracted,
  };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run();
}
