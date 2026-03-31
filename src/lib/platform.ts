export type Platform = 'unix' | 'windows';
export type MuxCommand = 'tmux' | 'psmux';

const _platform: Platform = process.platform === 'win32' ? 'windows' : 'unix';

let _muxCommand: MuxCommand | null | undefined = undefined;

export function detectPlatform(): Platform {
  return _platform;
}

export function detectMuxCommand(): MuxCommand | null {
  if (_muxCommand !== undefined) return _muxCommand;

  try {
    const tmuxResult = Bun.spawnSync(['tmux', '-V']);
    if (tmuxResult.exitCode === 0) {
      _muxCommand = 'tmux';
      return _muxCommand;
    }
  } catch {}

  try {
    const psmuxResult = Bun.spawnSync(['psmux', '-V']);
    if (psmuxResult.exitCode === 0) {
      _muxCommand = 'psmux';
      return _muxCommand;
    }
  } catch {}

  _muxCommand = null;
  return _muxCommand;
}

export function isMuxAvailable(): boolean {
  return detectMuxCommand() !== null;
}

const SESSION_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const PANE_PATTERN = /^(%[0-9]+|[a-zA-Z0-9_.-]+:[0-9]+(\.[0-9]+)?)$/;

export function validateSessionName(sessionName: string): string | null {
  if (!sessionName || !SESSION_NAME_PATTERN.test(sessionName)) {
    process.stderr.write(`[bridge] Invalid session name: "${sessionName}", rejecting.\n`);
    return null;
  }
  return sessionName;
}

export function validatePaneTarget(pane: string): string | null {
  if (!pane || !PANE_PATTERN.test(pane)) {
    process.stderr.write(`[bridge] Invalid pane target: "${pane}", rejecting.\n`);
    return null;
  }
  return pane;
}

export function discoverMuxPaneTarget(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicitTarget = env.BRIDGE_PANE_TARGET?.trim();
  if (explicitTarget) {
    return validatePaneTarget(explicitTarget) ?? undefined;
  }

  const tmuxPane = env.TMUX_PANE?.trim();
  if (tmuxPane) {
    return validatePaneTarget(tmuxPane) ?? undefined;
  }

  return undefined;
}

async function muxSendKeysReal(paneTarget: string, text: string): Promise<boolean> {
  const cmd = detectMuxCommand();
  if (!cmd) {
    process.stderr.write('[bridge] No terminal multiplexer found (tmux/psmux). Trigger skipped.\n');
    return false;
  }
  const safePane = validatePaneTarget(paneTarget);
  if (!safePane) {
    return false;
  }
  try {
    const proc = Bun.spawn([cmd, 'send-keys', '-t', safePane, text, 'Enter']);
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch (err) {
    process.stderr.write(`[bridge] muxSendKeys failed: ${err}\n`);
    return false;
  }
}

let _muxImpl: (paneTarget: string, text: string) => Promise<boolean> = muxSendKeysReal;

export async function muxSendKeys(paneTarget: string, text: string): Promise<boolean> {
  return _muxImpl(paneTarget, text);
}

export function __setMuxMock(mock: (paneTarget: string, text: string) => Promise<boolean>): void {
  _muxImpl = mock;
}

export function __resetMuxMock(): void {
  _muxImpl = muxSendKeysReal;
}
