import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listProjects, type ProjectSummary } from '../src/prompts/list.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prompts-list-'));
}

function makeEntry(display: string, timestamp: number, project: string, sessionId: string): string {
  return JSON.stringify({ display, pastedContents: {}, timestamp, project, sessionId });
}

describe('listProjects', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()!;
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it('returns project summaries sorted by prompt count descending', () => {
    const root = tmpDir(); dirs.push(root);
    const archivePath = join(root, 'archive.jsonl');

    writeFileSync(archivePath, [
      makeEntry('a', 1000, 'C:\\proj\\Alpha', 's1'),
      makeEntry('b', 2000, 'C:\\proj\\Alpha', 's1'),
      makeEntry('c', 3000, 'C:\\proj\\Alpha', 's2'),
      makeEntry('d', 4000, 'C:\\proj\\Beta', 's3'),
    ].join('\n') + '\n');

    const result = listProjects({ archivePath });

    expect(result.length).toBe(2);
    expect(result[0].slug).toBe('Alpha');
    expect(result[0].count).toBe(3);
    expect(result[0].sessions).toBe(2);
    expect(result[1].slug).toBe('Beta');
    expect(result[1].count).toBe(1);
    expect(result[1].sessions).toBe(1);
  });

  it('includes date range per project', () => {
    const root = tmpDir(); dirs.push(root);
    const archivePath = join(root, 'archive.jsonl');

    writeFileSync(archivePath, [
      makeEntry('a', new Date('2026-03-01T00:00:00Z').getTime(), 'C:\\proj\\X', 's1'),
      makeEntry('b', new Date('2026-04-15T00:00:00Z').getTime(), 'C:\\proj\\X', 's1'),
    ].join('\n') + '\n');

    const result = listProjects({ archivePath });

    expect(result[0].firstDate).toBe('2026-03-01');
    expect(result[0].lastDate).toBe('2026-04-15');
  });

  it('returns empty array when archive does not exist', () => {
    const root = tmpDir(); dirs.push(root);
    const result = listProjects({ archivePath: join(root, 'nonexistent.jsonl') });
    expect(result).toEqual([]);
  });
});
