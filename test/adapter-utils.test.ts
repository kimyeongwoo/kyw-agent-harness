import { describe, expect, it } from 'bun:test';
import { normalizeWaitMs } from '../src/lib/adapter-utils.js';
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS } from '../src/lib/constants.js';

describe('normalizeWaitMs', () => {
  it('uses the default timeout for invalid values', () => {
    expect(normalizeWaitMs(undefined)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
    expect(normalizeWaitMs(-1)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
  });

  it('clamps wait timeouts to the configured maximum', () => {
    expect(normalizeWaitMs(MAX_WAIT_TIMEOUT_MS + 1)).toBe(MAX_WAIT_TIMEOUT_MS);
  });
});
