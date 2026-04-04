import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { exportPrompts, type ExportOptions } from '../src/prompts/export.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prompts-export-'));
}

function makeEntry(display: string, timestamp: number, project: string, sessionId: string): string {
  return JSON.stringify({ display, pastedContents: {}, timestamp, project, sessionId });
}

describe('exportPrompts', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()!;
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  function setup(entries: string[]): { archivePath: string; exportsDir: string } {
    const root = tmpDir(); dirs.push(root);
    const archivePath = join(root, 'archive.jsonl');
    const exportsDir = join(root, 'exports');
    writeFileSync(archivePath, entries.join('\n') + '\n');
    return { archivePath, exportsDir };
  }

  it('exports all entries grouped by project and date', () => {
    const { archivePath, exportsDir } = setup([
      makeEntry('hello', new Date('2026-04-04T13:00:00Z').getTime(), 'C:\\proj\\A', 's1'),
      makeEntry('world', new Date('2026-04-04T14:00:00Z').getTime(), 'C:\\proj\\A', 's1'),
      makeEntry('other', new Date('2026-04-04T10:00:00Z').getTime(), 'C:\\proj\\B', 's2'),
    ]);

    const result = exportPrompts({ archivePath, exportsDir });

    expect(result.filesWritten).toBe(2);
    const mdA = readFileSync(join(exportsDir, 'A', '2026-04-04.md'), 'utf-8');
    expect(mdA).toContain('# A -- 2026-04-04');
    expect(mdA).toContain('hello');
    expect(mdA).toContain('world');
    expect(mdA.indexOf('hello')).toBeLessThan(mdA.indexOf('world'));

    const mdB = readFileSync(join(exportsDir, 'B', '2026-04-04.md'), 'utf-8');
    expect(mdB).toContain('# B -- 2026-04-04');
    expect(mdB).toContain('other');
  });

  it('filters by project name (case insensitive partial match)', () => {
    const { archivePath, exportsDir } = setup([
      makeEntry('yes', 1000, 'C:\\proj\\MyApp', 's1'),
      makeEntry('no', 2000, 'C:\\proj\\Other', 's2'),
    ]);

    const result = exportPrompts({ archivePath, exportsDir, project: 'myapp' });

    expect(result.filesWritten).toBe(1);
    expect(existsSync(join(exportsDir, 'MyApp'))).toBe(true);
    expect(existsSync(join(exportsDir, 'Other'))).toBe(false);
  });

  it('filters by date range', () => {
    const { archivePath, exportsDir } = setup([
      makeEntry('old', new Date('2026-03-01T10:00:00Z').getTime(), 'C:\\proj\\A', 's1'),
      makeEntry('in-range', new Date('2026-04-02T10:00:00Z').getTime(), 'C:\\proj\\A', 's1'),
      makeEntry('future', new Date('2026-05-01T10:00:00Z').getTime(), 'C:\\proj\\A', 's1'),
    ]);

    const result = exportPrompts({ archivePath, exportsDir, from: '2026-04-01', to: '2026-04-30' });

    expect(result.filesWritten).toBe(1);
    const md = readFileSync(join(exportsDir, 'A', '2026-04-02.md'), 'utf-8');
    expect(md).toContain('in-range');
    expect(md).not.toContain('old');
    expect(md).not.toContain('future');
  });

  it('filters by keyword', () => {
    const { archivePath, exportsDir } = setup([
      makeEntry('run tests please', 1000, 'C:\\proj\\A', 's1'),
      makeEntry('deploy it', 2000, 'C:\\proj\\A', 's1'),
    ]);

    const result = exportPrompts({ archivePath, exportsDir, keyword: 'tests' });

    expect(result.filesWritten).toBe(1);
    const md = readFileSync(join(exportsDir, 'A') + '/1970-01-01.md', 'utf-8');
    expect(md).toContain('run tests please');
    expect(md).not.toContain('deploy it');
  });

  it('overwrites existing export files (idempotent)', () => {
    const { archivePath, exportsDir } = setup([
      makeEntry('first', new Date('2026-04-04T10:00:00Z').getTime(), 'C:\\proj\\A', 's1'),
    ]);

    exportPrompts({ archivePath, exportsDir });
    exportPrompts({ archivePath, exportsDir });

    const md = readFileSync(join(exportsDir, 'A', '2026-04-04.md'), 'utf-8');
    const count = (md.match(/## /g) || []).length;
    expect(count).toBe(1);
  });

  it('formats markdown with session short ID and time', () => {
    const { archivePath, exportsDir } = setup([
      makeEntry('my prompt', new Date('2026-04-04T13:11:00Z').getTime(), 'C:\\proj\\X', 'abcdef12-3456-7890-abcd-ef1234567890'),
    ]);

    exportPrompts({ archivePath, exportsDir });

    const md = readFileSync(join(exportsDir, 'X', '2026-04-04.md'), 'utf-8');
    expect(md).toContain('## 13:11 | session: abcdef12');
    expect(md).toContain('my prompt');
  });
});
