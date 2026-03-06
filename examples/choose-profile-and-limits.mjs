/**
 * Goal: Show how profiles and explicit limits change archive audit outcomes.
 * Prereqs:
 * - Run from repo root after `npm run build`.
 * Run:
 * - `node examples/choose-profile-and-limits.mjs`
 * Expected output:
 * - JSON object with `{ ok: true, compatOk, strictFailureCode }`.
 * Safety notes:
 * - Uses in-memory fixtures only; no filesystem or network access.
 */
import { ArchiveError, ZipError, openArchive } from "../dist/index.js";
import { makeZipBytes } from "./_helpers.mjs";

export async function run() {
  const bytes = await makeZipBytes([
    { name: "safe/readme.txt", content: "alpha" },
    { name: "safe/guide.txt", content: "beta" },
  ]);

  const compatReader = await openArchive(bytes, { profile: "compat" });
  const compatReport = await compatReader.audit({ profile: "compat" });

  let strictFailureCode = "UNSET";
  let strictFailureMessage = "UNSET";
  try {
    await openArchive(bytes, {
      profile: "strict",
      limits: {
        maxUncompressedEntryBytes: 4,
        maxTotalUncompressedBytes: 8,
      },
    });
    throw new Error("Expected strict limits to fail.");
  } catch (error) {
    if (!(error instanceof ArchiveError || error instanceof ZipError)) {
      throw error;
    }
    strictFailureCode = error.code;
    strictFailureMessage = error.message;
  }

  const payload = {
    ok: true,
    compatOk: compatReport.ok,
    strictFailureCode,
    strictFailureMessage,
  };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run();
}
