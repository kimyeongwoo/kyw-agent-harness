/**
 * Shared instance detection logic: register the current process, list other
 * live instances for the same slot, and clean up stale PID files.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { isProcessAlive } from './process-utils.js';

export interface InstanceRecord {
  pid: number;
  slot?: string;
}

export function ensureInstanceDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function instanceFileFor(dir: string, pid: number): string {
  return `${dir}/${pid}.pid`;
}

export function parseInstancePid(entry: string): number | null {
  if (!entry.endsWith('.pid')) return null;
  const pid = Number.parseInt(entry.slice(0, -4), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function readInstanceRecord(path: string, pid: number): InstanceRecord {
  try {
    const text = readFileSync(path, 'utf-8');
    return { pid, ...(JSON.parse(text) as Partial<InstanceRecord>) };
  } catch {
    return { pid };
  }
}

export function registerCurrentInstance(dir: string, slot: string): void {
  ensureInstanceDir(dir);
  try {
    writeFileSync(
      instanceFileFor(dir, process.pid),
      JSON.stringify({ pid: process.pid, slot }),
      'utf-8',
    );
  } catch {}
}

export function listOtherLiveInstancePids(dir: string, slot: string): number[] {
  ensureInstanceDir(dir);
  const others: number[] = [];

  try {
    for (const entry of readdirSync(dir)) {
      const pid = parseInstancePid(entry);
      if (pid === null || pid === process.pid) continue;

      const path = `${dir}/${entry}`;
      if (isProcessAlive(pid)) {
        const record = readInstanceRecord(path, pid);
        if (!record.slot || record.slot === slot) {
          others.push(pid);
        }
      } else {
        try { unlinkSync(path); } catch {}
      }
    }
  } catch {}

  return others;
}

export function unregisterInstance(dir: string): void {
  try { unlinkSync(instanceFileFor(dir, process.pid)); } catch {}
}
