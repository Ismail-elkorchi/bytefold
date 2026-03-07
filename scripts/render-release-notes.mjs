import { buildReleaseNotes, parseReleaseCliArgs } from './release-notes-lib.mjs';

function main() {
  const options = parseReleaseCliArgs(process.argv.slice(2));
  const notes = buildReleaseNotes(options);

  process.stdout.write(`${notes.markdown}\n`);

  if (options.dryRun) {
    process.stderr.write(`[dry-run] rendered ${notes.pullRequests.length} pull requests\n`);
  }
}

main();
