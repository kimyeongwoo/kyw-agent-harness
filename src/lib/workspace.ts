import { spawnSync } from 'child_process';
import { resolve } from 'path';

export const BRIDGE_WORKSPACE_ROOT_ENV = 'BRIDGE_WORKSPACE_ROOT';

export function detectGitRoot(cwd = process.cwd()): string | undefined {
  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return undefined;

    const text = result.stdout.trim();
    return text.length > 0 ? resolve(text) : undefined;
  } catch {
    return undefined;
  }
}

export function detectWorkspaceRoot(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredRoot = env[BRIDGE_WORKSPACE_ROOT_ENV]?.trim();
  if (configuredRoot) {
    return resolve(configuredRoot);
  }

  return detectGitRoot(cwd) ?? resolve(cwd);
}

export const WORKSPACE_ROOT = detectWorkspaceRoot();

export function resolveWorkspacePath(...segments: string[]): string {
  return resolve(WORKSPACE_ROOT, ...segments);
}
