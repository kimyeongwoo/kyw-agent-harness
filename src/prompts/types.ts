import { resolve } from 'path';
import { homedir } from 'os';

export interface HistoryEntry {
  display: string;
  pastedContents: Record<string, unknown>;
  timestamp: number;
  project: string;
  sessionId: string;
}

export interface SyncWatermark {
  last_timestamp: number;
  last_line_count: number;
  synced_at: string;
}

export const HISTORY_JSONL_PATH = resolve(homedir(), '.claude', 'history.jsonl');
export const PROMPT_HISTORY_DIR = resolve(homedir(), '.claude', 'prompt-history');
export const ARCHIVE_JSONL_PATH = resolve(PROMPT_HISTORY_DIR, 'archive.jsonl');
export const WATERMARK_PATH = resolve(PROMPT_HISTORY_DIR, 'last-sync.json');
export const EXPORTS_DIR = resolve(PROMPT_HISTORY_DIR, 'exports');

export function parseHistoryLine(line: string): HistoryEntry | null {
  try {
    const obj = JSON.parse(line);
    if (
      typeof obj.display !== 'string' ||
      typeof obj.timestamp !== 'number' ||
      typeof obj.project !== 'string' ||
      typeof obj.sessionId !== 'string'
    ) {
      return null;
    }
    return obj as HistoryEntry;
  } catch {
    return null;
  }
}

export function extractProjectSlug(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || 'unknown';
}

export function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function makeDedupeKey(timestamp: number, sessionId: string, display: string): string {
  return `${timestamp}|${sessionId}|${display}`;
}
