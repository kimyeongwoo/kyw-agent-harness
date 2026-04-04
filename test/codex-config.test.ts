import { describe, expect, it } from 'bun:test';
import { buildCodexBridgeSection, upsertCodexBridgeConfig } from '../src/lib/codex-config.js';

describe('codex bridge config helpers', () => {
  it('renders bridge sections with and without slot env', () => {
    const withSlot = buildCodexBridgeSection({
      bunCommand: 'bun',
      codexPath: 'C:/bridge/start-codex.ts',
      slotValue: 'demo',
    });
    const withoutSlot = buildCodexBridgeSection({
      bunCommand: 'bun',
      codexPath: 'C:/bridge/start-codex.ts',
    });

    expect(withSlot).toContain('env = { BRIDGE_SLOT = "demo" }');
    expect(withoutSlot).not.toContain('BRIDGE_SLOT');
  });

  it('replaces an existing bridge block and preserves unrelated tables', () => {
    const existing = [
      '[mcp_servers.bridge]',
      'command = "bun"',
      'args = ["old"]',
      '',
      '[other]',
      'value = 1',
      '',
    ].join('\n');

    const updated = upsertCodexBridgeConfig(existing, {
      bunCommand: 'bun',
      codexPath: 'C:/bridge/start-codex.ts',
      slotValue: 'demo',
    });

    expect(updated).toContain('args = ["C:/bridge/start-codex.ts"]');
    expect(updated).toContain('env = { BRIDGE_SLOT = "demo" }');
    expect(updated).toContain('[other]\nvalue = 1');
    expect(updated).not.toContain('args = ["old"]');
  });

  it('appends the bridge block when the config has no existing bridge section', () => {
    const existing = [
      '[other]',
      'value = 1',
      '',
    ].join('\n');

    const updated = upsertCodexBridgeConfig(existing, {
      bunCommand: 'bun',
      codexPath: 'C:/bridge/start-codex.ts',
    });

    expect(updated).toContain('[other]\nvalue = 1');
    expect(updated).toContain('[mcp_servers.bridge]');
    expect(updated).toContain('args = ["C:/bridge/start-codex.ts"]');
  });
});
