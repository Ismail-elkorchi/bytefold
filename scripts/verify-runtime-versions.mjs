import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

class RuntimeVersionError extends Error {
  constructor(runtime, required, actual) {
    super(`${runtime} ${actual} does not satisfy required ${required}`);
    this.name = 'CompressionError';
    this.code = 'COMPRESSION_UNSUPPORTED_ALGORITHM';
    this.hint = `Install ${runtime} ${required} or newer.`;
    this.context = { runtime, required: String(required), actual: String(actual) };
  }

  toJSON() {
    return {
      schemaVersion: '1',
      name: this.name,
      code: this.code,
      message: this.message,
      hint: this.hint,
      context: this.context
    };
  }
}

const ROOT = process.cwd();
const versionsPath = path.join(ROOT, 'tools', 'runtime-versions.json');
const versions = JSON.parse(await readFile(versionsPath, 'utf8'));

const targets = [
  { runtime: 'node', command: [process.execPath, ['--version']], parser: parseNodeVersion },
  { runtime: 'deno', command: ['deno', ['--version']], parser: parseDenoVersion },
  { runtime: 'bun', command: ['bun', ['--version']], parser: parseBunVersion }
];

for (const target of targets) {
  const requirement = versions[target.runtime];
  if (!requirement) continue;
  const actual = getVersion(target.runtime, target.command[0], target.command[1]);
  const actualVersion = target.parser(actual);
  const minimum = parseMinimum(requirement);
  if (!actualVersion) {
    throw new RuntimeVersionError(target.runtime, requirement, actual.trim() || 'unknown');
  }
  if (compareSemver(actualVersion, minimum) < 0) {
    throw new RuntimeVersionError(target.runtime, requirement, actualVersion.raw);
  }
}

function getVersion(runtime, cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.status === 0) {
    return result.stdout || result.stderr || '';
  }
  if (result.error) {
    throw new RuntimeVersionError(runtime, String(versions[runtime] ?? ''), 'missing');
  }
  if (result.status !== 0) {
    throw new RuntimeVersionError(runtime, String(versions[runtime] ?? ''), result.stderr || 'unknown');
  }
  return '';
}

function parseMinimum(value) {
  const match = String(value).match(/>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) {
    throw new RuntimeVersionError('runtime', String(value), 'invalid requirement');
  }
  const major = match[1];
  const minor = match[2] ?? '0';
  const patch = match[3] ?? '0';
  const parsed = parseSemver(`${major}.${minor}.${patch}`);
  if (!parsed) throw new RuntimeVersionError('runtime', String(value), 'invalid requirement');
  return parsed;
}

function parseNodeVersion(output) {
  const match = output.match(/v(\d+\.\d+\.\d+)/);
  if (!match) return null;
  return parseSemver(match[1]);
}

function parseDenoVersion(output) {
  const match = output.match(/deno\s+(\d+\.\d+\.\d+)/i);
  if (!match) return null;
  return parseSemver(match[1]);
}

function parseBunVersion(output) {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  if (!match) return null;
  return parseSemver(match[1]);
}

function parseSemver(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: `${match[1]}.${match[2]}.${match[3]}`
  };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}
