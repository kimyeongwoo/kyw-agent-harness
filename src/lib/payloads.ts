import { mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { relative, resolve } from 'path';
import { MESSAGE_ATTACHMENT_CHAR_THRESHOLD, PAYLOADS_DIR, WORKSPACE_ROOT } from './constants.js';
import type { MessageAttachment } from './types.js';

export interface PreparedMessagePayload {
  content: string;
  attachments?: MessageAttachment[];
}

function getCharCount(text: string): number {
  return Array.from(text).length;
}

function truncatePreview(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) {
    return normalized;
  }
  return `${chars.slice(0, maxChars).join('')}...`;
}

export async function prepareMessagePayload(
  sender: 'claude' | 'codex',
  sessionId: string,
  text: string,
  options?: { messageId?: string },
): Promise<PreparedMessagePayload> {
  const charCount = getCharCount(text);

  if (charCount <= MESSAGE_ATTACHMENT_CHAR_THRESHOLD) {
    return { content: text };
  }

  const sessionDir = resolve(PAYLOADS_DIR, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = options?.messageId ? `${options.messageId}.md` : `${timestamp}-${sender}-${randomUUID()}.md`;
  const absolutePath = resolve(sessionDir, fileName);
  const relativePath = relative(WORKSPACE_ROOT, absolutePath).replace(/\\/g, '/');

  await Bun.write(absolutePath, text);

  const attachment: MessageAttachment = {
    kind: 'oversized-message',
    path: relativePath,
    required: true,
    char_count: charCount,
  };

  const content = [
    'SUMMARY: Oversized message content was written to an attachment document.',
    `PREVIEW: ${truncatePreview(text, 280)}`,
    `ATTACHMENT: ${relativePath}`,
    'REQUIRED: You must read the attachment document before responding.',
  ].join('\n');

  return {
    content,
    attachments: [attachment],
  };
}
