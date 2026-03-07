/**
 * Goal: Demonstrate stable error codes for unsupported archive input.
 * Prereqs:
 * - Run from repo root after `npm run build`.
 * Run:
 * - `node examples/troubleshoot-errors.mjs`
 * Expected output:
 * - JSON object with `{ ok: true, name, code, message }`.
 * Safety notes:
 * - Uses an in-memory invalid payload; no filesystem or network access.
 */
import { ArchiveError, ZipError, openArchive } from "../dist/index.js";

export async function run() {
  try {
    await openArchive(new TextEncoder().encode("not-an-archive"), { profile: "strict" });
    throw new Error("Expected unsupported input to fail.");
  } catch (error) {
    if (!(error instanceof ArchiveError || error instanceof ZipError)) {
      throw error;
    }

    const payload = {
      ok: true,
      name: error.name,
      code: error.code,
      message: error.message,
    };
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run();
}
