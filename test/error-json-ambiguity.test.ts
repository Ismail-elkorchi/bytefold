import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ArchiveError, createArchiveWriter, openArchive } from '@ismail-elkorchi/bytefold';
import { CompressionError, createCompressor, createDecompressor } from '@ismail-elkorchi/bytefold/compress';
import { ZipError } from '@ismail-elkorchi/bytefold/zip';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const ERROR_SCHEMA = new URL('../schemas/error.schema.json', import.meta.url);
const XZ_BAD = new URL('../test/fixtures/xz-utils/bad-1-check-crc32.xz', import.meta.url);

type ErrorJson = {
  schemaVersion: string;
  name: string;
  code: string;
  message: string;
  hint: string;
  context: Record<string, string>;
  entryName?: string;
  method?: number;
  offset?: string;
  algorithm?: string;
};

test('error JSON context avoids top-level shadow keys across subsystems', async () => {
  const schema = (JSON.parse(await readFile(ERROR_SCHEMA, 'utf8')) as unknown) as JsonSchema;
  const { HttpError } = (await import(new URL('../dist/http/errors.js', import.meta.url).href)) as {
    HttpError: new (
      code: 'HTTP_RANGE_INVALID',
      message: string,
      options?: { context?: Record<string, string> }
    ) => { toJSON(): ErrorJson };
  };

  const errors: Array<{ label: string; value: { toJSON: () => ErrorJson } }> = [];
  errors.push({
    label: 'zip-class',
    value: new ZipError('ZIP_BAD_CRC', 'CRC mismatch', {
      entryName: 'crc.txt',
      method: 8,
      offset: 42n,
      context: {
        code: 'shadow',
        message: 'shadow',
        entryName: 'shadow.txt',
        method: '9',
        offset: '7',
        detail: 'zip'
      }
    })
  });
  errors.push({
    label: 'archive-class',
    value: new ArchiveError('ARCHIVE_BAD_HEADER', 'Bad header', {
      entryName: 'bad.tar',
      offset: 9n,
      context: {
        code: 'shadow',
        hint: 'shadow',
        entryName: 'shadow.tar',
        offset: '99',
        detail: 'archive'
      }
    })
  });
  errors.push({
    label: 'compression-class',
    value: new CompressionError('COMPRESSION_XZ_BAD_DATA', 'XZ decode failed', {
      algorithm: 'xz',
      context: {
        code: 'shadow',
        algorithm: 'shadow',
        detail: 'compression'
      }
    })
  });
  errors.push({
    label: 'http-class',
    value: new HttpError('HTTP_RANGE_INVALID', 'Range is invalid', {
      context: {
        code: 'shadow',
        name: 'shadow',
        message: 'shadow',
        hint: 'shadow',
        requestedRange: 'bytes=0-1'
      }
    })
  });

  let unsupportedError: unknown;
  try {
    createCompressor({ algorithm: 'xz' });
  } catch (err) {
    unsupportedError = err;
  }
  assert.ok(unsupportedError instanceof CompressionError);
  errors.push({
    label: 'compress-unsupported-runtime',
    value: unsupportedError as CompressionError
  });

  const tarBytes = await buildTarWithSymlink();
  const tarReader = await openArchive(tarBytes, { format: 'tar' });
  let tarError: unknown;
  try {
    await normalizeArchive(tarReader);
  } catch (err) {
    tarError = err;
  }
  assert.ok(tarError instanceof ArchiveError);
  errors.push({ label: 'tar-normalize-runtime', value: tarError as ArchiveError });

  const zipBytes = await buildZipWithSymlink();
  const zipReader = await openArchive(zipBytes, { format: 'zip' });
  let zipError: unknown;
  try {
    await normalizeArchive(zipReader);
  } catch (err) {
    zipError = err;
  }
  assert.ok(zipError instanceof ZipError);
  errors.push({ label: 'zip-normalize-runtime', value: zipError as ZipError });

  const badXz = new Uint8Array(await readFile(XZ_BAD));
  let xzError: unknown;
  try {
    await collect(readableFromBytes(badXz).pipeThrough(createDecompressor({ algorithm: 'xz' })));
  } catch (err) {
    xzError = err;
  }
  assert.ok(xzError instanceof CompressionError);
  errors.push({ label: 'xz-runtime', value: xzError as CompressionError });

  for (const entry of errors) {
    const json = entry.value.toJSON();
    const schemaResult = validateSchema(schema, json);
    assert.ok(schemaResult.ok, `${entry.label}: ${schemaResult.errors.join('\n')}`);
    assertNoShadowedContextKeys(json);
  }
});

function assertNoShadowedContextKeys(json: ErrorJson): void {
  const topLevelKeys = new Set(Object.keys(json));
  for (const key of Object.keys(json.context)) {
    assert.equal(
      topLevelKeys.has(key),
      false,
      `context key ${key} must not shadow top-level error JSON key`
    );
  }
}

async function buildTarWithSymlink(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('tar', writable);
  await writer.add('link', undefined, { type: 'symlink', linkName: 'target' });
  await writer.close();
  return concatChunks(chunks);
}

async function buildZipWithSymlink(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('zip', writable);
  const symlinkAttrs = 0o120777 << 16;
  await writer.add('link', new TextEncoder().encode('target'), { externalAttributes: symlinkAttrs });
  await writer.close();
  return concatChunks(chunks);
}

async function normalizeArchive(reader: {
  normalizeToWritable?: (writable: WritableStream<Uint8Array>, options?: { isDeterministic?: boolean }) => Promise<unknown>;
}): Promise<unknown> {
  const writable = new WritableStream<Uint8Array>({
    write() {
      // discard output
    }
  });
  const normalizeToWritable = reader.normalizeToWritable?.bind(reader);
  if (!normalizeToWritable) {
    throw new Error('normalizeToWritable missing');
  }
  return normalizeToWritable(writable, { isDeterministic: true });
}

function readableFromBytes(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatChunks(chunks);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
