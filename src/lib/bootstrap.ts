import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve } from 'path';

type SpawnSyncLike = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: ['ignore', 'pipe', 'pipe'] },
) => {
  status: number | null;
  stdout?: Uint8Array | string | null;
  stderr?: Uint8Array | string | null;
  error?: Error | null;
};

interface EnsureDependenciesInstalledOptions {
  existsSyncImpl?: (path: string) => boolean;
  spawnSyncImpl?: SpawnSyncLike;
  writeStderr?: (text: string) => void;
}

function toText(value: Uint8Array | string | null | undefined): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf-8');
  return '';
}

export function ensureDependenciesInstalled(
  root: string,
  options: EnsureDependenciesInstalledOptions = {},
): void {
  const existsSyncImpl = options.existsSyncImpl ?? existsSync;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const writeStderr = options.writeStderr ?? ((text: string) => process.stderr.write(text));
  const nodeModulesDir = resolve(root, 'node_modules');

  if (existsSyncImpl(nodeModulesDir)) {
    return;
  }

  writeStderr('[bridge] node_modules not found. Running bun install...\n');
  const result = spawnSyncImpl('bun', ['install'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const installStdout = toText(result.stdout);
  const installStderr = toText(result.stderr);
  if (installStdout) writeStderr(installStdout);
  if (installStderr) writeStderr(installStderr);

  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? 'bun install failed. Please run "bun install" manually.');
  }

  writeStderr('[bridge] Dependencies installed successfully.\n');
}
