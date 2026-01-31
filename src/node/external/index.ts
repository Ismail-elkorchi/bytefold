import { spawn, spawnSync } from 'node:child_process';
import { ExternalToolError } from './errors.js';

export type SevenZipEntry = {
  path: string;
  size?: number;
  packedSize?: number;
  isDirectory?: boolean;
  modified?: string;
  method?: string;
  encrypted?: boolean;
  attributes?: string;
  crc?: string;
};

export type SevenZipListResult = {
  entries: SevenZipEntry[];
  tool: string;
};

export type SevenZipOptions = {
  password?: string;
  signal?: AbortSignal;
};

export async function listWith7z(path: string, options?: SevenZipOptions): Promise<SevenZipListResult> {
  const tool = resolve7zTool();
  if (!tool) {
    throw new ExternalToolError('EXTERNAL_TOOL_MISSING', '7z executable not found', { tool: '7z' });
  }
  const args = ['l', '-slt'];
  if (options?.password) {
    args.push(`-p${options.password}`);
  }
  args.push(path);

  const { stdout } = await runTool(tool, args, options?.signal);
  return {
    tool,
    entries: parseSevenZipList(stdout, path)
  };
}

export async function extractWith7z(
  path: string,
  dest: string,
  options?: SevenZipOptions
): Promise<void> {
  const tool = resolve7zTool();
  if (!tool) {
    throw new ExternalToolError('EXTERNAL_TOOL_MISSING', '7z executable not found', { tool: '7z' });
  }
  const args = ['x', '-y', `-o${dest}`];
  if (options?.password) {
    args.push(`-p${options.password}`);
  }
  args.push(path);
  await runTool(tool, args, options?.signal);
}

export { ExternalToolError } from './errors.js';

function resolve7zTool(): string | null {
  if (commandExists('7z')) return '7z';
  if (commandExists('7za')) return '7za';
  return null;
}

function commandExists(cmd: string): boolean {
  const result = spawnSync('bash', ['-lc', `command -v ${cmd}`], { stdio: 'ignore' });
  return result.status === 0;
}

function runTool(
  tool: string,
  args: string[],
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });

    const abortHandler = () => {
      child.kill();
      reject(
        new ExternalToolError('EXTERNAL_TOOL_FAILED', '7z process aborted', {
          tool
        })
      );
    };

    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    child.on('error', (err) => {
      reject(new ExternalToolError('EXTERNAL_TOOL_FAILED', 'Failed to launch 7z', { tool, cause: err }));
    });

    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', abortHandler);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new ExternalToolError('EXTERNAL_TOOL_FAILED', `7z exited with code ${code ?? 'unknown'}`, {
          tool,
          cause: stderr.trim() ? new Error('7z stderr captured') : undefined
        })
      );
    });
  });
}

function parseSevenZipList(output: string, archivePath: string): SevenZipEntry[] {
  const entries: SevenZipEntry[] = [];
  let current: Record<string, string> = {};

  const flush = () => {
    if (!current.Path) {
      current = {};
      return;
    }
    if (current.Path === archivePath && current.Type) {
      current = {};
      return;
    }
    const entry: SevenZipEntry = {
      path: current.Path
    };
    const size = toNumber(current.Size);
    if (size !== undefined) entry.size = size;
    const packedSize = toNumber(current['Packed Size']);
    if (packedSize !== undefined) entry.packedSize = packedSize;
    if (current.Folder) entry.isDirectory = current.Folder === '+';
    if (current.Modified) entry.modified = current.Modified;
    if (current.Method) entry.method = current.Method;
    if (current.Encrypted) entry.encrypted = current.Encrypted === '+';
    if (current.Attributes) entry.attributes = current.Attributes;
    if (current.CRC) entry.crc = current.CRC;
    entries.push(entry);
    current = {};
  };

  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    const idx = line.indexOf(' = ');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 3).trim();
    current[key] = value;
  }
  flush();
  return entries;
}

function toNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}
