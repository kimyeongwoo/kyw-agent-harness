export interface CodexBridgeConfigOptions {
  bunCommand: string;
  codexPath: string;
  slotValue?: string;
}

const BRIDGE_TABLE_HEADER = '[mcp_servers.bridge]';

function normalizeToml(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function isTableHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']');
}

function renderToml(text: string): string {
  return text.length > 0 ? `${text}\n` : '';
}

export function buildCodexBridgeSection(options: CodexBridgeConfigOptions): string {
  return [
    BRIDGE_TABLE_HEADER,
    `command = "${options.bunCommand}"`,
    `args = ["${options.codexPath}"]`,
    ...(options.slotValue ? [`env = { BRIDGE_SLOT = "${options.slotValue}" }`] : []),
  ].join('\n');
}

export function upsertCodexBridgeConfig(existingText: string, options: CodexBridgeConfigOptions): string {
  const normalized = normalizeToml(existingText);
  const section = buildCodexBridgeSection(options);
  const lines = normalized.split('\n');
  const start = lines.findIndex((line) => line.trim() === BRIDGE_TABLE_HEADER);

  if (start === -1) {
    const prefix = normalized.trimEnd();
    return renderToml(prefix.length > 0 ? `${prefix}\n\n${section}` : section);
  }

  let end = start + 1;
  while (end < lines.length && !isTableHeader(lines[end])) {
    end++;
  }

  const before = lines.slice(0, start).join('\n').trimEnd();
  const after = lines.slice(end).join('\n').trimStart();
  return renderToml([before, section, after].filter((part) => part.length > 0).join('\n\n'));
}
