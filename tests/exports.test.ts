import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolError } from '../src/errors.js';
import {
  countCsvRows,
  defaultFilename,
  listExportFiles,
  sanitizeFilename,
  writeExportFile,
} from '../src/exports.js';

let exportDir: string;

beforeEach(() => {
  exportDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'toggl-mcp-exports-')));
});

afterEach(() => {
  fs.rmSync(exportDir, { recursive: true, force: true });
});

describe('sanitizeFilename', () => {
  it('keeps safe names and forces the extension', () => {
    expect(sanitizeFilename('report.csv', 'csv')).toBe('report.csv');
    expect(sanitizeFilename('report', 'csv')).toBe('report.csv');
    expect(sanitizeFilename('report.CSV', 'csv')).toBe('report.csv');
    expect(sanitizeFilename('report.pdf', 'csv')).toBe('report.pdf.csv');
  });

  it('strips path separators and control characters', () => {
    expect(sanitizeFilename('a/b\\c.csv', 'csv')).toBe('abc.csv');
    expect(sanitizeFilename('re\u0000po\u001frt.csv', 'csv')).toBe('report.csv');
  });

  it('rejects traversal, reserved names, and empty results', () => {
    expect(() => sanitizeFilename('..', 'csv')).toThrow(ToolError);
    expect(() => sanitizeFilename('name..csv', 'csv')).toThrow(ToolError);
    expect(() => sanitizeFilename('CON', 'csv')).toThrow(ToolError);
    expect(() => sanitizeFilename('lpt1.csv', 'csv')).toThrow(ToolError);
    expect(() => sanitizeFilename('   ', 'csv')).toThrow(ToolError);
    expect(() => sanitizeFilename('...', 'csv')).toThrow(ToolError);
  });

  it('removes trailing dots and spaces and caps the length', () => {
    expect(sanitizeFilename('name... ', 'csv')).toBe('name.csv');
    const long = 'x'.repeat(300);
    const result = sanitizeFilename(long, 'csv');
    expect(result.length).toBeLessThanOrEqual(124);
    expect(result.endsWith('.csv')).toBe(true);
  });
});

describe('defaultFilename', () => {
  it('embeds report type, range, and timestamp', () => {
    const now = new Date('2026-07-27T01:02:03.456Z');
    expect(defaultFilename('detailed', '2026-07-01', '2026-07-31', 'csv', now)).toBe(
      'toggl-detailed-2026-07-01_2026-07-31-20260727-010203.csv',
    );
    expect(defaultFilename('weekly', '2026-07-01', undefined, 'pdf', now)).toBe(
      'toggl-weekly-2026-07-01-20260727-010203.pdf',
    );
  });
});

describe('writeExportFile', () => {
  it('writes bytes with restrictive permissions', async () => {
    const target = await writeExportFile(exportDir, 'report.csv', Buffer.from('a,b\n1,2\n'));
    expect(target).toBe(path.join(exportDir, 'report.csv'));
    expect(await fsp.readFile(target, 'utf8')).toBe('a,b\n1,2\n');
    expect((await fsp.stat(target)).mode & 0o777).toBe(0o600);
  });

  it('never overwrites: collisions get numeric suffixes', async () => {
    const first = await writeExportFile(exportDir, 'report.csv', Buffer.from('first'));
    const second = await writeExportFile(exportDir, 'report.csv', Buffer.from('second'));
    const third = await writeExportFile(exportDir, 'report.csv', Buffer.from('third'));
    expect(first).toBe(path.join(exportDir, 'report.csv'));
    expect(second).toBe(path.join(exportDir, 'report-1.csv'));
    expect(third).toBe(path.join(exportDir, 'report-2.csv'));
    expect(await fsp.readFile(first, 'utf8')).toBe('first');
    expect(await fsp.readFile(second, 'utf8')).toBe('second');
  });

  it('handles concurrent writes to the same name without losing data', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        writeExportFile(exportDir, 'same.csv', Buffer.from(`payload-${i}`)),
      ),
    );
    expect(new Set(results).size).toBe(5);
    const contents = await Promise.all(results.map((file) => fsp.readFile(file, 'utf8')));
    expect(new Set(contents).size).toBe(5);
  });

  it('rejects filenames that escape the export directory', async () => {
    await expect(
      writeExportFile(exportDir, '../escape.csv', Buffer.from('x')),
    ).rejects.toMatchObject({ code: 'INVALID_FILENAME' });
  });

  it('leaves no temp files behind', async () => {
    await writeExportFile(exportDir, 'report.csv', Buffer.from('data'));
    const leftovers = (await fsp.readdir(exportDir)).filter((name) => name.startsWith('.toggl'));
    expect(leftovers).toEqual([]);
  });
});

describe('countCsvRows', () => {
  it('counts data rows excluding the header', () => {
    expect(countCsvRows(Buffer.from('a,b\n1,2\n3,4\n'))).toBe(2);
    expect(countCsvRows(Buffer.from('a,b\n1,2'))).toBe(1);
    expect(countCsvRows(Buffer.from('a,b\n'))).toBe(0);
    expect(countCsvRows(Buffer.from(''))).toBe(0);
  });

  it('does not split on newlines inside quoted fields', () => {
    expect(countCsvRows(Buffer.from('a,b\n"multi\nline",2\n'))).toBe(1);
  });
});

describe('listExportFiles', () => {
  it('lists only pdf/csv regular files, newest first, with a limit', async () => {
    const mkfile = async (name: string, mtime: Date) => {
      const file = path.join(exportDir, name);
      await fsp.writeFile(file, 'x');
      await fsp.utimes(file, mtime, mtime);
    };
    await mkfile('old.csv', new Date('2026-01-01T00:00:00Z'));
    await mkfile('new.pdf', new Date('2026-06-01T00:00:00Z'));
    await mkfile('ignored.txt', new Date('2026-07-01T00:00:00Z'));
    await fsp.mkdir(path.join(exportDir, 'subdir.csv'));
    await fsp.symlink(path.join(exportDir, 'old.csv'), path.join(exportDir, 'link.csv'));

    const all = await listExportFiles(exportDir, 50);
    expect(all.map((f) => f.filename)).toEqual(['new.pdf', 'old.csv']);

    const limited = await listExportFiles(exportDir, 1);
    expect(limited.map((f) => f.filename)).toEqual(['new.pdf']);
  });
});
