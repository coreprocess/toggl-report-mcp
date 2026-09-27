import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Simulates a filesystem without hard-link support (exFAT/FAT32, some network
// mounts): fsp.link always fails with EPERM, forcing the exclusive-copy
// fallback path in writeExportFile.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const link = async () => {
    const err = new Error('EPERM: operation not permitted, link') as NodeJS.ErrnoException;
    err.code = 'EPERM';
    throw err;
  };
  return { ...actual, link, default: { ...actual, link } };
});

const { writeExportFile } = await import('../src/exports.js');

let exportDir: string;

beforeEach(() => {
  exportDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'toggl-mcp-fallback-')));
});

afterEach(() => {
  fs.rmSync(exportDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('writeExportFile on filesystems without hard links', () => {
  it('falls back to an exclusive copy', async () => {
    const target = await writeExportFile(exportDir, 'report.csv', Buffer.from('data'));
    expect(target).toBe(path.join(exportDir, 'report.csv'));
    expect(fs.readFileSync(target, 'utf8')).toBe('data');
  });

  it('still never overwrites: collisions get numeric suffixes', async () => {
    const first = await writeExportFile(exportDir, 'report.csv', Buffer.from('first'));
    const second = await writeExportFile(exportDir, 'report.csv', Buffer.from('second'));
    expect(first).toBe(path.join(exportDir, 'report.csv'));
    expect(second).toBe(path.join(exportDir, 'report-1.csv'));
    expect(fs.readFileSync(first, 'utf8')).toBe('first');
    expect(fs.readFileSync(second, 'utf8')).toBe('second');
  });

  it('leaves no temp files behind', async () => {
    await writeExportFile(exportDir, 'report.csv', Buffer.from('data'));
    const leftovers = fs.readdirSync(exportDir).filter((name) => name.startsWith('.toggl'));
    expect(leftovers).toEqual([]);
  });
});
