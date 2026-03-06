import { execFileSync } from 'node:child_process';

function runCommand(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

export function parseRepositoryFromRemote(remoteUrl) {
  const noGitSuffix = remoteUrl.endsWith('.git') ? remoteUrl.slice(0, -4) : remoteUrl;
  if (noGitSuffix.startsWith('git@github.com:')) {
    return noGitSuffix.slice('git@github.com:'.length);
  }
  if (noGitSuffix.startsWith('https://github.com/')) {
    return noGitSuffix.slice('https://github.com/'.length);
  }
  throw new Error(`release-notes: unsupported origin remote format: ${remoteUrl}`);
}

export function ghApiJson(pathname) {
  const output = runCommand('gh', ['api', pathname, '-H', 'Accept: application/vnd.github+json']);
  return JSON.parse(output);
}

export function resolveRepository() {
  const explicit = process.env.GITHUB_REPOSITORY?.trim();
  if (explicit) return explicit;
  const remoteUrl = runCommand('git', ['remote', 'get-url', 'origin']);
  return parseRepositoryFromRemote(remoteUrl);
}

export function resolveDefaultToRef() {
  try {
    const originHead = runCommand('git', ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    return originHead.replace('refs/remotes/origin/', '');
  } catch {
    return 'main';
  }
}

export function resolveReleaseRange({ fromTag, toRef } = {}) {
  const resolvedToRef = toRef ?? resolveDefaultToRef();
  let resolvedFromTag = fromTag;

  if (!resolvedFromTag) {
    const mergedTagsOutput = runCommand('git', [
      'tag',
      '--merged',
      resolvedToRef,
      '--sort=-creatordate',
      '--list',
      'v*.*.*'
    ]);
    const mergedTags = mergedTagsOutput.split('\n').map((tag) => tag.trim()).filter(Boolean);

    if (mergedTags.length === 0) {
      throw new Error(`release-notes: no release tags found that are reachable from ${resolvedToRef}`);
    }

    const pointsAtOutput = runCommand('git', ['tag', '--points-at', resolvedToRef, '--list', 'v*.*.*']);
    const pointsAtTags = new Set(pointsAtOutput.split('\n').map((tag) => tag.trim()).filter(Boolean));
    resolvedFromTag = mergedTags.find((tag) => !pointsAtTags.has(tag)) ?? mergedTags[0];
  }

  return {
    fromTag: resolvedFromTag,
    toRef: resolvedToRef
  };
}

export function listMergedPullRequests({ repository, fromTag, toRef }) {
  const compareEndpoint = `repos/${repository}/compare/${encodeURIComponent(fromTag)}...${encodeURIComponent(toRef)}`;
  const compare = ghApiJson(compareEndpoint);
  const commits = Array.isArray(compare.commits) ? compare.commits : [];
  const pullRequestByNumber = new Map();

  for (const commit of commits) {
    if (!commit?.sha) continue;
    const pulls = ghApiJson(`repos/${repository}/commits/${commit.sha}/pulls`);
    for (const pull of pulls) {
      if (!pull?.number || !pull?.merged_at) continue;
      pullRequestByNumber.set(pull.number, {
        number: pull.number,
        title: pull.title,
        url: pull.html_url,
        mergedAt: pull.merged_at
      });
    }
  }

  return [...pullRequestByNumber.values()].sort((left, right) => {
    const mergedAtOrder = left.mergedAt.localeCompare(right.mergedAt);
    if (mergedAtOrder !== 0) return mergedAtOrder;
    return left.number - right.number;
  });
}

export function loadPullRequestsByNumber(repository, ids) {
  const pullRequests = [];
  for (const id of [...ids].sort((left, right) => left - right)) {
    const pull = ghApiJson(`repos/${repository}/pulls/${id}`);
    pullRequests.push({
      number: id,
      title: String(pull?.title ?? `Pull request ${id}`),
      url: String(pull?.html_url ?? `https://github.com/${repository}/pull/${id}`),
      mergedAt: String(pull?.merged_at ?? '')
    });
  }
  return pullRequests;
}

export function renderPullRequestBullets(pullRequests) {
  if (pullRequests.length === 0) {
    return '- No merged pull requests in this range.';
  }

  return pullRequests
    .map((pullRequest) => `- [${pullRequest.title}](${pullRequest.url}) (#${pullRequest.number})`)
    .join('\n');
}

export function buildReleaseNotes(options = {}) {
  const repository = resolveRepository();
  const { fromTag, toRef } = resolveReleaseRange(options);
  const pullRequests = listMergedPullRequests({ repository, fromTag, toRef });
  const bulletList = renderPullRequestBullets(pullRequests);

  return {
    repository,
    fromTag,
    toRef,
    pullRequests,
    bulletList,
    markdown: [`### Changes (${fromTag}...${toRef})`, bulletList].join('\n')
  };
}

export function parseReleaseCliArgs(argv) {
  const options = { dryRun: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (argument === '--from-tag' || argument === '--from_tag') {
      options.fromTag = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--to-ref' || argument === '--to_ref') {
      options.toRef = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--changelog' || argument === '--changelog-file') {
      options.changelogPath = argv[index + 1];
      index += 1;
    }
  }

  return options;
}
