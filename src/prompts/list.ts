import { existsSync, readFileSync } from 'fs';
import {
  ARCHIVE_JSONL_PATH,
  parseHistoryLine,
  extractProjectSlug,
  formatDate,
} from './types.js';

export interface ProjectSummary {
  slug: string;
  count: number;
  sessions: number;
  firstDate: string;
  lastDate: string;
}

export interface ListOptions {
  archivePath?: string;
}

export function listProjects(opts: ListOptions = {}): ProjectSummary[] {
  const archivePath = opts.archivePath ?? ARCHIVE_JSONL_PATH;

  if (!existsSync(archivePath)) return [];

  const text = readFileSync(archivePath, 'utf-8');
  const projectMap = new Map<string, {
    count: number;
    sessions: Set<string>;
    minTs: number;
    maxTs: number;
  }>();

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const entry = parseHistoryLine(line);
    if (!entry) continue;

    const slug = extractProjectSlug(entry.project);
    if (!projectMap.has(slug)) {
      projectMap.set(slug, { count: 0, sessions: new Set(), minTs: Infinity, maxTs: 0 });
    }
    const info = projectMap.get(slug)!;
    info.count++;
    info.sessions.add(entry.sessionId);
    if (entry.timestamp < info.minTs) info.minTs = entry.timestamp;
    if (entry.timestamp > info.maxTs) info.maxTs = entry.timestamp;
  }

  const summaries: ProjectSummary[] = [];
  for (const [slug, info] of projectMap) {
    summaries.push({
      slug,
      count: info.count,
      sessions: info.sessions.size,
      firstDate: formatDate(info.minTs),
      lastDate: formatDate(info.maxTs),
    });
  }

  return summaries.sort((a, b) => b.count - a.count);
}
