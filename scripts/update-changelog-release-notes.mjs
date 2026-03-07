import { readFileSync, writeFileSync } from 'node:fs';

import { buildReleaseNotes, parseReleaseCliArgs } from './release-notes-lib.mjs';

const START_MARKER = '<!-- release-notes:start -->';
const END_MARKER = '<!-- release-notes:end -->';

function replaceRange(content, startIndex, endIndex, replacement) {
  return `${content.slice(0, startIndex)}${replacement}${content.slice(endIndex)}`;
}

function updateUnreleasedSection(changelogContent, notesBlock) {
  const unreleasedHeading = '## Unreleased';
  const headingIndex = changelogContent.indexOf(unreleasedHeading);
  if (headingIndex === -1) {
    throw new Error("CHANGELOG.md is missing a '## Unreleased' section.");
  }

  const afterHeading = changelogContent.indexOf('\n', headingIndex);
  const sectionStart = afterHeading + 1;
  const nextHeadingMatch = /^##\s+/gm;
  nextHeadingMatch.lastIndex = sectionStart;
  const nextHeading = nextHeadingMatch.exec(changelogContent);
  const sectionEnd = nextHeading ? nextHeading.index : changelogContent.length;
  const unreleasedSection = changelogContent.slice(sectionStart, sectionEnd);

  const markerStart = unreleasedSection.indexOf(START_MARKER);
  const markerEnd = unreleasedSection.indexOf(END_MARKER);
  const formattedBlock = `${START_MARKER}\n${notesBlock}\n${END_MARKER}\n\n`;

  if (markerStart !== -1 && markerEnd !== -1 && markerEnd >= markerStart) {
    const absoluteStart = sectionStart + markerStart;
    const absoluteEnd = sectionStart + markerEnd + END_MARKER.length;
    return replaceRange(changelogContent, absoluteStart, absoluteEnd, `${START_MARKER}\n${notesBlock}\n${END_MARKER}`);
  }

  const normalizedSection = unreleasedSection.startsWith('\n') ? unreleasedSection.slice(1) : unreleasedSection;
  return replaceRange(changelogContent, sectionStart, sectionEnd, `\n${formattedBlock}${normalizedSection}`);
}

function main() {
  const options = parseReleaseCliArgs(process.argv.slice(2));
  const notes = buildReleaseNotes(options);
  const changelogPath = options.changelogPath ?? 'CHANGELOG.md';
  const changelog = readFileSync(changelogPath, 'utf8');
  const notesBlock = [`### Candidate Notes (${notes.fromTag}...${notes.toRef})`, notes.bulletList].join('\n');
  const updatedChangelog = updateUnreleasedSection(changelog, notesBlock);

  if (options.dryRun) {
    process.stdout.write(`${notesBlock}\n`);
    process.stderr.write(`[dry-run] changelog would be updated at ${changelogPath}\n`);
    return;
  }

  writeFileSync(changelogPath, updatedChangelog);
  process.stdout.write(`Updated ${changelogPath} with release notes for ${notes.fromTag}...${notes.toRef}\n`);
}

main();
