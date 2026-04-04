import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { dirname } from 'path';
import {
  type SyncWatermark,
  HISTORY_JSONL_PATH,
  ARCHIVE_JSONL_PATH,
  WATERMARK_PATH,
  parseHistoryLine,
  makeDedupeKey,
} from './types.js';

export interface SyncOptions {
  historyPath?: string;
  archivePath?: string;
  watermarkPath?: string;
}

export interface SyncResult {
  newEntries: number;
  totalArchived: number;
  warning?: string;
}

export function syncHistory(opts: SyncOptions = {}): SyncResult {
  const historyPath = opts.historyPath ?? HISTORY_JSONL_PATH;
  const archivePath = opts.archivePath ?? ARCHIVE_JSONL_PATH;
  const watermarkPath = opts.watermarkPath ?? WATERMARK_PATH;

  mkdirSync(dirname(archivePath), { recursive: true });

  let watermark: SyncWatermark | null = null;
  if (existsSync(watermarkPath)) {
    try {
      watermark = JSON.parse(readFileSync(watermarkPath, 'utf-8'));
    } catch {}
  }

  const existingKeys = new Set<string>();
  if (existsSync(archivePath)) {
    const archiveText = readFileSync(archivePath, 'utf-8');
    for (const line of archiveText.split('\n')) {
      if (!line.trim()) continue;
      const entry = parseHistoryLine(line);
      if (entry) {
        existingKeys.add(makeDedupeKey(entry.timestamp, entry.sessionId, entry.display));
      }
    }
  }

  if (!existsSync(historyPath)) {
    return {
      newEntries: 0,
      totalArchived: existingKeys.size,
      warning: `history.jsonl not found at ${historyPath}. Using archive only.`,
    };
  }

  const historyText = readFileSync(historyPath, 'utf-8');
  const historyLines = historyText.split('\n').filter((l) => l.trim());

  const lastTimestamp = watermark?.last_timestamp ?? 0;
  const newLines: string[] = [];
  let maxTimestamp = lastTimestamp;

  for (const line of historyLines) {
    const entry = parseHistoryLine(line);
    if (!entry) continue;
    if (entry.timestamp <= lastTimestamp && watermark) continue;

    const key = makeDedupeKey(entry.timestamp, entry.sessionId, entry.display);
    if (existingKeys.has(key)) continue;

    newLines.push(line);
    existingKeys.add(key);
    if (entry.timestamp > maxTimestamp) {
      maxTimestamp = entry.timestamp;
    }
  }

  if (newLines.length > 0) {
    appendFileSync(archivePath, newLines.join('\n') + '\n');
  }

  const newWatermark: SyncWatermark = {
    last_timestamp: maxTimestamp,
    last_line_count: existingKeys.size,
    synced_at: new Date().toISOString(),
  };
  writeFileSync(watermarkPath, JSON.stringify(newWatermark, null, 2));

  return {
    newEntries: newLines.length,
    totalArchived: existingKeys.size,
  };
}
