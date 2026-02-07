import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENTRY_POINT = path.join(ROOT_DIR, 'web', 'mod.ts');
const OUTFILE = path.join(ROOT_DIR, '.tmp', 'web-check', 'bundle.js');

if (isEntrypoint()) {
  try {
    const result = await runWebCheck();
    process.stdout.write(`[bytefold][web:check] ok bytes=${result.bytes} sha256=${result.sha256}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[bytefold][web:check] failed: ${message}\n`);
    process.exitCode = 1;
  }
}

/**
 * @returns {Promise<{ bytes: number; sha256: string }>}
 */
export async function runWebCheck() {
  const result = await build({
    absWorkingDir: ROOT_DIR,
    entryPoints: [ENTRY_POINT],
    outfile: OUTFILE,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    sourcemap: false,
    logLevel: 'silent',
    plugins: [forbidNodeBuiltinImports()]
  });

  const output = result.outputFiles.find((file) => file.path.endsWith('bundle.js'));
  if (!output) {
    throw new Error('web bundle output was not produced');
  }
  const bytes = output.contents.length;
  const sha256 = createHash('sha256').update(output.contents).digest('hex');
  return { bytes, sha256 };
}

function forbidNodeBuiltinImports() {
  return {
    name: 'forbid-node-builtins',
    setup(buildContext) {
      buildContext.onResolve({ filter: /^node:/ }, (args) => {
        return {
          errors: [
            {
              text: `node builtin import is not allowed in web bundle: ${args.path}`,
              location: args.importer
                ? {
                    file: args.importer
                  }
                : undefined
            }
          ]
        };
      });
    }
  };
}

function isEntrypoint() {
  return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}
