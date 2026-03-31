#!/usr/bin/env node
const { spawnSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function findBun() {
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const ext = isWin ? '.exe' : '';

  if (process.env.BUN_INSTALL) {
    const p = path.join(process.env.BUN_INSTALL, 'bin', `bun${ext}`);
    if (fs.existsSync(p)) return p;
  }

  const dotBun = path.join(home, '.bun', 'bin', `bun${ext}`);
  if (fs.existsSync(dotBun)) return dotBun;

  if (isWin) {
    const npmBun = path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe');
    if (fs.existsSync(npmBun)) return npmBun;
  }

  try {
    const cmd = isWin ? 'where bun' : 'which bun';
    const result = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const first = result.split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return first;
  } catch {}

  return null;
}

const bunPath = findBun();

if (!bunPath) {
  console.error(`[kah] Error: bun executable not found.
Install bun:
  curl -fsSL https://bun.sh/install | bash        # macOS/Linux
  powershell -c "irm bun.sh/install.ps1 | iex"    # Windows
`);
  process.exit(1);
}

const script = path.join(__dirname, 'kah.ts');
const args = [script, ...process.argv.slice(2)];
const result = spawnSync(bunPath, args, { stdio: 'inherit' });

if (result.error) {
  console.error(`[kah] Failed to run bun at: ${bunPath}`);
  console.error(`[kah] Error: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status || 0);
