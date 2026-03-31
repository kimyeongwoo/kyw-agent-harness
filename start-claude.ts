import { resolve } from 'path';
import { ensureDependenciesInstalled } from './src/lib/bootstrap.js';

const root = resolve(import.meta.dir);

try {
  ensureDependenciesInstalled(root);
} catch (error) {
  process.stderr.write(`[harness] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

await import('./src/mcp/claude-server.ts');
