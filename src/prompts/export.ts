import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  type HistoryEntry,
  ARCHIVE_JSONL_PATH,
  EXPORTS_DIR,
  parseHistoryLine,
  extractProjectSlug,
  formatDate,
  formatTime,
} from './types.js';

export interface ExportOptions {
  archivePath?: string;
  exportsDir?: string;
  project?: string;
  from?: string;
  to?: string;
  keyword?: string;
}

export interface ExportResult {
  filesWritten: number;
  totalPrompts: number;
}

function matchesProject(entry: HistoryEntry, filter: string): boolean {
  const slug = extractProjectSlug(entry.project);
  return slug.toLowerCase().includes(filter.toLowerCase());
}

function matchesDateRange(entry: HistoryEntry, from?: string, to?: string): boolean {
  const date = formatDate(entry.timestamp);
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function matchesKeyword(entry: HistoryEntry, keyword: string): boolean {
  return entry.display.toLowerCase().includes(keyword.toLowerCase());
}

function renderMarkdown(project: string, date: string, entries: HistoryEntry[]): string {
  const lines: string[] = [`# ${project} -- ${date}`, ''];

  const sorted = entries.sort((a, b) => a.timestamp - b.timestamp);
  for (const entry of sorted) {
    const time = formatTime(entry.timestamp);
    const shortSession = entry.sessionId.slice(0, 8);
    lines.push(`## ${time} | session: ${shortSession}`);
    lines.push(entry.display);
    lines.push('');
  }

  return lines.join('\n');
}

export function exportPrompts(opts: ExportOptions = {}): ExportResult {
  const archivePath = opts.archivePath ?? ARCHIVE_JSONL_PATH;
  const exportsDir = opts.exportsDir ?? EXPORTS_DIR;

  if (!existsSync(archivePath)) {
    return { filesWritten: 0, totalPrompts: 0 };
  }

  const text = readFileSync(archivePath, 'utf-8');
  let entries: HistoryEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const entry = parseHistoryLine(line);
    if (entry) entries.push(entry);
  }

  if (opts.project) {
    entries = entries.filter((e) => matchesProject(e, opts.project!));
  }
  if (opts.from || opts.to) {
    entries = entries.filter((e) => matchesDateRange(e, opts.from, opts.to));
  }
  if (opts.keyword) {
    entries = entries.filter((e) => matchesKeyword(e, opts.keyword!));
  }

  const groups = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const slug = extractProjectSlug(entry.project);
    const date = formatDate(entry.timestamp);
    const key = `${slug}/${date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }

  let filesWritten = 0;
  for (const [key, groupEntries] of groups) {
    const [slug, date] = key.split('/');
    const dir = join(exportsDir, slug);
    mkdirSync(dir, { recursive: true });
    const md = renderMarkdown(slug, date, groupEntries);
    writeFileSync(join(dir, `${date}.md`), md);
    filesWritten++;
  }

  return { filesWritten, totalPrompts: entries.length };
}
