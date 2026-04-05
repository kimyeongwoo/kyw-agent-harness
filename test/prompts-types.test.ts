import { describe, expect, it } from 'bun:test';
import {
  extractProjectSlug,
  formatDate,
  formatTime,
  makeDedupeKey,
  parseHistoryLine,
  PROMPT_HISTORY_DIR,
} from '../src/prompts/types.js';

describe('parseHistoryLine', () => {
  it('parses a valid JSONL line', () => {
    const line = JSON.stringify({
      display: 'hello',
      pastedContents: {},
      timestamp: 1762331017850,
      project: 'C:\\1kyw\\5.personal\\agent_harness',
      sessionId: 'abc-123',
    });
    const entry = parseHistoryLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.display).toBe('hello');
    expect(entry!.timestamp).toBe(1762331017850);
    expect(entry!.project).toBe('C:\\1kyw\\5.personal\\agent_harness');
    expect(entry!.sessionId).toBe('abc-123');
  });

  it('returns null for malformed JSON', () => {
    expect(parseHistoryLine('not json')).toBeNull();
  });

  it('returns null for entry missing display', () => {
    const line = JSON.stringify({ timestamp: 123, project: 'x', sessionId: 'y' });
    expect(parseHistoryLine(line)).toBeNull();
  });
});

describe('extractProjectSlug', () => {
  it('extracts last segment from Windows path', () => {
    expect(extractProjectSlug('C:\\1kyw\\6.ibksystem\\ITSM')).toBe('ITSM');
  });

  it('extracts last segment from Unix path', () => {
    expect(extractProjectSlug('/home/user/projects/my-app')).toBe('my-app');
  });

  it('returns unknown for empty string', () => {
    expect(extractProjectSlug('')).toBe('unknown');
  });
});

describe('formatDate', () => {
  it('formats timestamp to YYYY-MM-DD in local time', () => {
    // Use a fixed local date to avoid timezone-dependent failures
    const d = new Date(2026, 3, 4, 13, 11, 0); // April 4, 2026 13:11 local
    expect(formatDate(d.getTime())).toBe('2026-04-04');
  });
});

describe('formatTime', () => {
  it('formats timestamp to HH:mm in local time', () => {
    const d = new Date(2026, 3, 4, 5, 3, 0); // April 4, 2026 05:03 local
    expect(formatTime(d.getTime())).toBe('05:03');
  });
});

describe('makeDedupeKey', () => {
  it('creates a stable key from entry fields', () => {
    const key = makeDedupeKey(1762331017850, 'sess-1', 'hello');
    expect(key).toBe('1762331017850|sess-1|hello');
  });
});

describe('PROMPT_HISTORY_DIR', () => {
  it('is under ~/.claude/', () => {
    expect(PROMPT_HISTORY_DIR).toContain('.claude');
    expect(PROMPT_HISTORY_DIR).toContain('prompt-history');
  });
});
