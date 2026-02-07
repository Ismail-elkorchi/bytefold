import test from 'node:test';
import assert from 'node:assert/strict';

const LIMITS_MODULE = new URL('../dist/limits.js', import.meta.url);
const TAR_MODULE = new URL('../dist/tar/TarReader.js', import.meta.url);
const ZIP_MODULE = new URL('../dist/reader/ZipReader.js', import.meta.url);
const NODE_ZIP_MODULE = new URL('../dist/node/zip/ZipReader.js', import.meta.url);

test('resource limits defaults are single-source-of-truth', async () => {
  const { DEFAULT_RESOURCE_LIMITS, AGENT_RESOURCE_LIMITS } = (await import(LIMITS_MODULE.href)) as {
    DEFAULT_RESOURCE_LIMITS: unknown;
    AGENT_RESOURCE_LIMITS: unknown;
  };
  const { __getTarDefaultsForProfile } = (await import(TAR_MODULE.href)) as {
    __getTarDefaultsForProfile: (profile: 'compat' | 'strict' | 'agent') => unknown;
  };
  const { __getZipDefaultsForProfile } = (await import(ZIP_MODULE.href)) as {
    __getZipDefaultsForProfile: (profile: 'compat' | 'strict' | 'agent') => unknown;
  };
  const { __getNodeZipDefaultsForProfile } = (await import(NODE_ZIP_MODULE.href)) as {
    __getNodeZipDefaultsForProfile: (profile: 'compat' | 'strict' | 'agent') => unknown;
  };

  assert.strictEqual(__getTarDefaultsForProfile('strict'), DEFAULT_RESOURCE_LIMITS);
  assert.strictEqual(__getTarDefaultsForProfile('compat'), DEFAULT_RESOURCE_LIMITS);
  assert.strictEqual(__getTarDefaultsForProfile('agent'), AGENT_RESOURCE_LIMITS);

  assert.strictEqual(__getZipDefaultsForProfile('strict'), DEFAULT_RESOURCE_LIMITS);
  assert.strictEqual(__getZipDefaultsForProfile('compat'), DEFAULT_RESOURCE_LIMITS);
  assert.strictEqual(__getZipDefaultsForProfile('agent'), AGENT_RESOURCE_LIMITS);

  assert.strictEqual(__getNodeZipDefaultsForProfile('strict'), DEFAULT_RESOURCE_LIMITS);
  assert.strictEqual(__getNodeZipDefaultsForProfile('compat'), DEFAULT_RESOURCE_LIMITS);
  assert.strictEqual(__getNodeZipDefaultsForProfile('agent'), AGENT_RESOURCE_LIMITS);
});
