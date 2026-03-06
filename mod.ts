/**
 * Multi-format archive reader/writer with safety profiles and deterministic normalization.
 * Supports Node 24+, Deno, Bun, and browsers (via the web entrypoint).
 *
 * Install:
 * ```sh
 * npm install @ismail-elkorchi/bytefold
 * deno add jsr:@ismail-elkorchi/bytefold
 * ```
 *
 * Quickstart:
 * ```ts
 * import { openArchive } from "./mod.ts";
 *
 * export async function auditArchive(bytes: Uint8Array): Promise<boolean> {
 *   const reader = await openArchive(bytes, { profile: "agent" });
 *   const report = await reader.audit({ profile: "agent" });
 *   if (!report.ok) return false;
 *   await reader.assertSafe({ profile: "agent" });
 *   return true;
 * }
 * ```
 *
 * Where next:
 * - Docs index: https://github.com/Ismail-elkorchi/bytefold/blob/main/docs/index.md
 * - Options reference: https://github.com/Ismail-elkorchi/bytefold/blob/main/docs/reference/options.md
 * - How-to (audit first): https://github.com/Ismail-elkorchi/bytefold/blob/main/docs/how-to/audit-before-extract.md
 * - SPEC: https://github.com/Ismail-elkorchi/bytefold/blob/main/SPEC.md
 * - SECURITY: https://github.com/Ismail-elkorchi/bytefold/blob/main/SECURITY.md
 *
 * @module
 */
export * from './src/index.ts';
