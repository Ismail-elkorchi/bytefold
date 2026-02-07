import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ArchiveError, createArchiveWriter, openArchive } from '@ismail-elkorchi/bytefold';
import { CompressionError, createCompressor } from '@ismail-elkorchi/bytefold/compress';
import { ZipError, ZipReader } from '@ismail-elkorchi/bytefold/zip';
import { extractAll } from '@ismail-elkorchi/bytefold/node';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateSchema, type JsonSchema } from './schema-validator.js';

const ERROR_SCHEMA = new URL('../schemas/error.schema.json', import.meta.url);
const XZ_BAD = new URL('../test/fixtures/xz-utils/bad-1-check-crc32.xz', import.meta.url);

const encoder = new TextEncoder();

test('exported error classes serialize with hint + context and match schema', async () => {
  const schema = (JSON.parse(await readFile(ERROR_SCHEMA, 'utf8')) as unknown) as JsonSchema;
  const errors = [
    new ZipError('ZIP_BAD_CRC', 'CRC mismatch', { entryName: 'file.txt', method: 8, offset: 42n }),
    new ArchiveError('ARCHIVE_BAD_HEADER', 'Bad header', { entryName: 'file.txt', offset: 12n }),
    new CompressionError('COMPRESSION_XZ_BAD_DATA', 'XZ data error', { algorithm: 'xz' })
  ];

  for (const err of errors) {
    const json = err.toJSON();
    assert.ok(json.schemaVersion === '1');
    assert.ok(json.hint.length > 0);
    assert.ok(Object.keys(json.context).length > 0);
    const result = validateSchema(schema, json);
    assert.ok(result.ok, result.errors.join('\n'));
  }
});

test('boundary failures throw typed errors with JSON contracts', async () => {
  const schema = (JSON.parse(await readFile(ERROR_SCHEMA, 'utf8')) as unknown) as JsonSchema;

  await assert.rejects(
    async () => {
      await openArchive(new Uint8Array([0x00]));
    },
    (err: unknown) => {
      if (!(err instanceof ArchiveError)) return false;
      const json = err.toJSON();
      const result = validateSchema(schema, json);
      if (!result.ok) return false;
      return json.hint.length > 0 && Object.keys(json.context).length > 0;
    }
  );

  assert.throws(
    () => {
      createCompressor({ algorithm: 'xz' });
    },
    (err: unknown) => {
      if (!(err instanceof CompressionError)) return false;
      const json = err.toJSON();
      const result = validateSchema(schema, json);
      if (!result.ok) return false;
      return json.hint.length > 0 && Object.keys(json.context).length > 0;
    }
  );

  const target = path.join(tmpdir(), 'bytefold-error-contract');
  const bad = new Uint8Array(await readFile(XZ_BAD));
  await assert.rejects(
    async () => {
      await extractAll(bad, target, { filename: 'bad-1-check-crc32.xz' });
    },
    (err: unknown) => {
      if (!(err instanceof CompressionError)) return false;
      const json = err.toJSON();
      const result = validateSchema(schema, json);
      if (!result.ok) return false;
      return json.hint.length > 0 && Object.keys(json.context).length > 0;
    }
  );

  const zipBytes = await buildSymlinkZip();
  const reader = await ZipReader.fromUint8Array(zipBytes);
  await assert.rejects(
    async () => {
      const chunks: Uint8Array[] = [];
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk);
        }
      });
      await reader.normalizeToWritable(writable, { onSymlink: 'error' });
    },
    (err: unknown) => {
      if (!(err instanceof ZipError)) return false;
      const json = err.toJSON();
      const result = validateSchema(schema, json);
      if (!result.ok) return false;
      return json.hint.length > 0 && Object.keys(json.context).length > 0;
    }
  );
});

async function buildSymlinkZip(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    }
  });
  const writer = createArchiveWriter('zip', writable);
  const symlinkAttrs = 0o120777 << 16;
  await writer.add('link', encoder.encode('target'), { externalAttributes: symlinkAttrs });
  await writer.close();
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
