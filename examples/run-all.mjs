/**
 * Goal: Execute all `bytefold` examples and assert stable output contracts.
 * Prereqs:
 * - Run from repo root after `npm run build`.
 * Run:
 * - `node examples/run-all.mjs`
 * Expected output:
 * - Final line `examples:run bytefold PASS` and process exit code `0`.
 * Safety notes:
 * - Offline harness; no external network operations.
 */
import assert from "node:assert/strict";
import { run as runInspectBrowser } from "./inspect-upload-in-browser.mjs";
import { run as runAuditBeforeExtract } from "./audit-before-extract.mjs";
import { run as runChooseProfileAndLimits } from "./choose-profile-and-limits.mjs";
import { run as runNormalizeForDiffs } from "./normalize-for-diffs.mjs";
import { run as runTroubleshootErrors } from "./troubleshoot-errors.mjs";

const inspect = await runInspectBrowser();
assert.equal(inspect.ok, true);
assert.equal(inspect.format, "zip");
assert.equal(inspect.entries.length > 0, true);

const audit = await runAuditBeforeExtract();
assert.equal(audit.ok, true);
assert.equal(audit.auditOk, true);
assert.equal(audit.extracted.length, 2);

const normalize = await runNormalizeForDiffs();
assert.equal(normalize.ok, true);
assert.equal(normalize.reportOk, true);
assert.equal(typeof normalize.outputBytes, "number");

const limits = await runChooseProfileAndLimits();
assert.equal(limits.ok, true);
assert.equal(limits.compatOk, true);
assert.equal(typeof limits.strictFailureCode, "string");
assert.equal(limits.strictFailureCode.length > 0, true);

const troubleshoot = await runTroubleshootErrors();
assert.equal(troubleshoot.ok, true);
assert.equal(typeof troubleshoot.code, "string");
assert.equal(troubleshoot.code.length > 0, true);

console.log("examples:run bytefold PASS");
