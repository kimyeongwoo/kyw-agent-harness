import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { syncHistory } from '../src/prompts/sync.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prompts-sync-'));
}

function makeEntry(display: string, timestamp: number, project: string, sessionId: string): string {
  return JSON.stringify({ display, pastedContents: {}, timestamp, project, sessionId });
}

describe('syncHistory', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()!;
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it('performs initial full sync when no archive exists', () => {
    const root = tmpDir(); dirs.push(root);
    const historyPath = join(root, 'history.jsonl');
    const archivePath = join(root, 'archive.jsonl');
    const watermarkPath = join(root, 'last-sync.json');

    writeFileSync(historyPath, [
      makeEntry('first', 1000, 'C:\\proj\\A', 's1'),
      makeEntry('second', 2000, 'C:\\proj\\B', 's2'),
    ].join('\n') + '\n');

    const result = syncHistory({ historyPath, archivePath, watermarkPath });

    expect(result.newEntries).toBe(2);
    expect(existsSync(archivePath)).toBe(true);
    const lines = readFileSync(archivePath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);

    const wm = JSON.parse(readFileSync(watermarkPath, 'utf-8'));
    expect(wm.last_timestamp).toBe(2000);
    expect(wm.last_line_count).toBe(2);
  });

  it('performs incremental sync using watermark', () => {
    const root = tmpDir(); dirs.push(root);
    const historyPath = join(root, 'history.jsonl');
    const archivePath = join(root, 'archive.jsonl');
    const watermarkPath = join(root, 'last-sync.json');

    writeFileSync(archivePath, makeEntry('first', 1000, 'C:\\proj\\A', 's1') + '\n');
    writeFileSync(watermarkPath, JSON.stringify({
      last_timestamp: 1000, last_line_count: 1, synced_at: '2026-01-01T00:00:00.000Z',
    }));

    writeFileSync(historyPath, [
      makeEntry('first', 1000, 'C:\\proj\\A', 's1'),
      makeEntry('second', 2000, 'C:\\proj\\B', 's2'),
    ].join('\n') + '\n');

    const result = syncHistory({ historyPath, archivePath, watermarkPath });

    expect(result.newEntries).toBe(1);
    const lines = readFileSync(archivePath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
  });

  it('skips duplicates during sync', () => {
    const root = tmpDir(); dirs.push(root);
    const historyPath = join(root, 'history.jsonl');
    const archivePath = join(root, 'archive.jsonl');
    const watermarkPath = join(root, 'last-sync.json');

    const entry = makeEntry('same', 1000, 'C:\\proj\\A', 's1');
    writeFileSync(archivePath, entry + '\n');
    writeFileSync(watermarkPath, JSON.stringify({
      last_timestamp: 500, last_line_count: 0, synced_at: '2026-01-01T00:00:00.000Z',
    }));
    writeFileSync(historyPath, entry + '\n');

    const result = syncHistory({ historyPath, archivePath, watermarkPath });
    expect(result.newEntries).toBe(0);
    const lines = readFileSync(archivePath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
  });

  it('warns when history.jsonl is missing and archive exists', () => {
    const root = tmpDir(); dirs.push(root);
    const historyPath = join(root, 'history.jsonl');
    const archivePath = join(root, 'archive.jsonl');
    const watermarkPath = join(root, 'last-sync.json');

    writeFileSync(archivePath, makeEntry('old', 1000, 'C:\\proj\\A', 's1') + '\n');

    const result = syncHistory({ historyPath, archivePath, watermarkPath });
    expect(result.newEntries).toBe(0);
    expect(result.warning).toContain('history.jsonl');
  });
});
