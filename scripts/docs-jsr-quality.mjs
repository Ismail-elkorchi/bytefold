import { execFileSync } from 'node:child_process';

const ENTRYPOINT = 'mod.ts';
const docJson = JSON.parse(execFileSync('deno', ['doc', '--json', '--sloppy-imports', ENTRYPOINT], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024
}));

const issues = [];
const nodes = new Map((docJson.nodes ?? []).map((node) => [node.name, node]));

checkClass('ZipReader', {
  properties: ['profile', 'strict', 'limits', 'warningsList', 'entriesList', 'password', 'storeEntries', 'eocd', 'signal', 'reader'],
  methods: [
    'fromRandomAccess',
    'fromUint8Array',
    'fromStream',
    'fromUrl',
    'entries',
    'warnings',
    'iterEntries',
    'open',
    'openRaw',
    'openEntryStream',
    'normalizeToWritable',
    'audit',
    'assertSafe',
    'close',
    'init',
    'loadEntries',
    'applyEntryLimits',
    'resolveAuditSettings',
    'resolveSignal',
    'normalizeToSink',
    'collectNormalizedEntries'
  ]
});
checkClass('ZipWriter', {
  properties: ['entries', 'closed', 'forceZip64', 'defaultMethod', 'patchLocalHeaders', 'defaultEncryption', 'progress', 'signal'],
  methods: ['toWritable', 'add', 'close']
});
checkClass('TarReader', {
  properties: ['profile', 'strict', 'limits', 'warningsList', 'entriesList', 'storeEntries', 'signal'],
  methods: ['fromUint8Array', 'fromStream', 'fromUrl', 'entries', 'warnings', 'iterEntries', 'open', 'audit', 'assertSafe', 'normalizeToWritable', 'resolveAuditSettings', 'init']
});
checkClass('TarWriter', {
  properties: ['writer', 'deterministic', 'signal', 'closed', 'paxCounter'],
  methods: ['toWritable', 'add', 'close', 'writePaxHeader', 'pipeData', 'writePadding', 'writeChunk']
});

checkTypeLiteralProperties('ZipProgressOptions', ['onProgress', 'progressIntervalMs', 'progressChunkInterval']);
checkTypeLiteralProperties('ZipAuditReport', ['summary']);
checkTypeLiteralProperties('ZipNormalizeReport', ['summary']);
checkTypeLiteralProperties('ZipReaderOptions', ['http']);
checkTypeLiteralProperties('ZipWarning', ['code', 'message', 'entryName']);
checkTypeLiteralProperties('ZipWriterCloseOptions', ['signal']);
checkTypeLiteralProperties('ZipCompressionCodec', ['methodId', 'name', 'supportsStreaming']);
checkTypeLiteralMethods('ZipCompressionCodec', ['createDecompressStream', 'createCompressStream']);
checkTypeLiteralProperties('ZipCompressionOptions', ['signal']);
checkTypeLiteralProperties('ZipDecompressionOptions', ['signal']);
checkTypeLiteralProperties('CompressionProgressEvent', ['kind', 'algorithm', 'bytesIn', 'bytesOut']);
checkTypeLiteralMethods('ArchiveWriter', ['add', 'close']);
checkTypeLiteralMethods('ArchiveReader', ['entries', 'audit', 'assertSafe', 'normalizeToWritable']);
checkTypeAlias('ArchiveWriterAddOptions');

const archiveWriterNode = nodes.get('ArchiveWriter');
const archiveWriterAdd = archiveWriterNode?.typeAliasDef?.tsType?.typeLiteral?.methods?.find((method) => method.name === 'add');
if (!archiveWriterAdd) {
  issues.push('ArchiveWriter.add: missing from generated docs');
} else if (containsWeakType(archiveWriterAdd)) {
  issues.push('ArchiveWriter.add: signature still exposes any/unknown');
}

if (issues.length > 0) {
  process.stderr.write('docs-jsr-quality: selected surfaces failed quality checks\n');
  for (const issue of issues) {
    process.stderr.write(`- ${issue}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write('docs-jsr-quality: verified selected JSR reader/writer surfaces\n');
}

function checkClass(name, requirements) {
  const node = nodes.get(name);
  if (!node) {
    issues.push(`${name}: missing from generated docs`);
    return;
  }
  requireMeaningfulDoc(node, name);

  for (const propertyName of requirements.properties ?? []) {
    const property = node.classDef?.properties?.find((entry) => entry.name === propertyName);
    if (!property) {
      issues.push(`${name}.${propertyName}: property missing from generated docs`);
      continue;
    }
    requireMeaningfulDoc(property, `${name}.${propertyName}`);
  }

  for (const methodName of requirements.methods ?? []) {
    const method = node.classDef?.methods?.find((entry) => entry.name === methodName);
    if (!method) {
      issues.push(`${name}.${methodName}: method missing from generated docs`);
      continue;
    }
    requireMeaningfulDoc(method, `${name}.${methodName}`);
  }
}

function checkTypeAlias(name) {
  const node = nodes.get(name);
  if (!node) {
    issues.push(`${name}: missing from generated docs`);
    return;
  }
  requireMeaningfulDoc(node, name);
}

function checkTypeLiteralProperties(name, propertyNames) {
  const node = nodes.get(name);
  if (!node) {
    issues.push(`${name}: missing from generated docs`);
    return;
  }
  requireMeaningfulDoc(node, name);
  const properties = node.typeAliasDef?.tsType?.typeLiteral?.properties ?? [];
  for (const propertyName of propertyNames) {
    const property = properties.find((entry) => entry.name === propertyName);
    if (!property) {
      issues.push(`${name}.${propertyName}: property missing from generated docs`);
      continue;
    }
    requireMeaningfulDoc(property, `${name}.${propertyName}`);
  }
}

function checkTypeLiteralMethods(name, methodNames) {
  const node = nodes.get(name);
  if (!node) {
    issues.push(`${name}: missing from generated docs`);
    return;
  }
  requireMeaningfulDoc(node, name);
  const methods = node.typeAliasDef?.tsType?.typeLiteral?.methods ?? [];
  for (const methodName of methodNames) {
    const method = methods.find((entry) => entry.name === methodName);
    if (!method) {
      issues.push(`${name}.${methodName}: method missing from generated docs`);
      continue;
    }
    requireMeaningfulDoc(method, `${name}.${methodName}`);
  }
}

function requireMeaningfulDoc(value, label) {
  const doc = value?.jsDoc?.doc?.replace(/\s+/g, ' ').trim() ?? '';
  if (doc.length < 12) {
    issues.push(`${label}: missing meaningful doc`);
  }
}

function containsWeakType(value) {
  if (value === 'any' || value === 'unknown') return true;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some((entry) => containsWeakType(entry));
}
