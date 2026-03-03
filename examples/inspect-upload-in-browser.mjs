/**
 * Goal: Demonstrate browser-oriented upload inspection using the web entrypoint.
 * Prereqs:
 * - Run from repo root after `npm run build`.
 * Run:
 * - `node examples/inspect-upload-in-browser.mjs`
 * Expected output:
 * - JSON object with `{ ok: true, format: "zip", entries }`.
 * Safety notes:
 * - Uses in-memory `Blob` input; no network access.
 */
import { openArchive } from "../dist/web/index.js";
import { makeZipBytes } from "./_helpers.mjs";

export async function run() {
  const bytes = await makeZipBytes([
    { name: "upload/readme.txt", content: "browser upload fixture" },
  ]);

  const uploadedFile = new Blob([bytes], { type: "application/zip" });
  const reader = await openArchive(uploadedFile, { profile: "agent" });
  const entries = [];
  for await (const entry of reader.entries()) {
    entries.push({
      name: entry.name,
      size: entry.size.toString(),
    });
  }

  const payload = {
    ok: true,
    format: reader.format,
    entries,
  };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run();
}
