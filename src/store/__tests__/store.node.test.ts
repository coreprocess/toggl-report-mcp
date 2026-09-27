/** Tests for the export store: filenames, no-overwrite publishing, listing and CSV row counts. */

import { mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolError } from '#errors/errors';
import { countCsvRows, ExportStore } from '../store.contract.ts';

describe('ExportStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'toggl-report-mcp-')), 'exports');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes data under a generated name derived from the base name. */
  function writeDefault(store: ExportStore, data: Uint8Array) {
    return store.write({
      filename: undefined,
      defaultBaseName: 'summary-9',
      extension: 'pdf',
      data,
    });
  }

  it('writes the data under a timestamped name and reports path and size', async () => {
    const store = new ExportStore(dir);
    const data = new TextEncoder().encode('a,b,c\n1,2,3\n');

    const stored = await writeDefault(store, data);

    expect(basename(stored.path)).toMatch(/^summary-9-\d{8}-\d{6}\.pdf$/);
    expect(stored.bytes).toBe(data.byteLength);
    expect(await readFile(stored.path, 'utf8')).toBe('a,b,c\n1,2,3\n');
    expect(await readdir(dir)).toEqual([basename(stored.path)]);
  });

  it('never overwrites: collisions get a numeric suffix', async () => {
    const store = new ExportStore(dir);
    const write = (byte: number) =>
      store.write({
        filename: 'report.pdf',
        defaultBaseName: 'unused',
        extension: 'pdf',
        data: new Uint8Array([byte]),
      });

    const first = await write(1);
    const second = await write(2);

    expect(basename(first.path)).toBe('report.pdf');
    expect(basename(second.path)).toBe('report-1.pdf');
    expect(await readFile(first.path)).toEqual(Buffer.from([1]));
    expect(await readFile(second.path)).toEqual(Buffer.from([2]));
  });

  it('keeps every concurrent write to the same name', async () => {
    const store = new ExportStore(dir);

    const stored = await Promise.all(
      [0, 1, 2, 3, 4].map((byte) =>
        store.write({
          filename: 'same.csv',
          defaultBaseName: 'unused',
          extension: 'csv',
          data: new Uint8Array([byte]),
        }),
      ),
    );

    // Five distinct files, each holding exactly the bytes of its own write.
    expect(new Set(stored.map((file) => file.path)).size).toBe(5);
    const contents = await Promise.all(stored.map(async (file) => (await readFile(file.path))[0]));
    expect(contents).toEqual([0, 1, 2, 3, 4]);
    expect((await readdir(dir)).sort()).toEqual([
      'same-1.csv',
      'same-2.csv',
      'same-3.csv',
      'same-4.csv',
      'same.csv',
    ]);
  });

  it('does not follow a symlink planted at the destination', async () => {
    const store = new ExportStore(dir);
    await store.write({
      filename: 'seed.csv',
      defaultBaseName: 'unused',
      extension: 'csv',
      data: new Uint8Array([0]),
    });
    const victim = join(dir, '..', 'victim.txt');
    await writeFile(victim, 'untouched');
    await symlink(victim, join(dir, 'trap.csv'));

    const stored = await store.write({
      filename: 'trap.csv',
      defaultBaseName: 'unused',
      extension: 'csv',
      data: new Uint8Array([1]),
    });

    expect(basename(stored.path)).toBe('trap-1.csv');
    expect(await readFile(victim, 'utf8')).toBe('untouched');
  });

  it('sanitizes caller filenames and enforces the extension', async () => {
    const store = new ExportStore(dir);
    const write = (filename: string) =>
      store.write({
        filename,
        defaultBaseName: 'unused',
        extension: 'csv',
        data: new Uint8Array([1]),
      });

    expect(basename((await write('/etc/pass:wd')).path)).toBe('etcpasswd.csv');
    await expect(write('../escape')).rejects.toMatchObject({ code: 'INVALID_FILENAME' });
    expect(basename((await write('july.CSV')).path)).toBe('july.csv');
    expect(basename((await write('july.pdf')).path)).toBe('july.pdf.csv');
    await expect(write('a..b')).rejects.toMatchObject({ code: 'INVALID_FILENAME' });
    await expect(write('CON')).rejects.toMatchObject({ code: 'INVALID_FILENAME' });
    await expect(write(' ... ')).rejects.toBeInstanceOf(ToolError);
  });

  it('recreates the directory when it was deleted mid-session', async () => {
    const store = new ExportStore(dir);
    await writeDefault(store, new Uint8Array([1]));

    // Simulate the user deleting the export directory while the server keeps running.
    await rm(dir, { recursive: true, force: true });

    const stored = await writeDefault(store, new Uint8Array([2]));
    expect(await readFile(stored.path)).toEqual(Buffer.from([2]));
  });

  it('lists export files newest first, skipping other files and symlinks', async () => {
    const store = new ExportStore(dir);
    expect(await store.list(10)).toEqual([]);

    await writeDefault(store, new Uint8Array([1]));
    await writeFile(join(dir, 'old.csv'), 'a\n1\n');
    await utimes(join(dir, 'old.csv'), new Date(2000, 0, 1), new Date(2000, 0, 1));
    await writeFile(join(dir, 'notes.txt'), 'x');
    await symlink(join(dir, 'old.csv'), join(dir, 'link.csv'));

    const listing = await store.list(10);
    expect(listing.map((file) => file.filename)).toEqual([
      expect.stringMatching(/^summary-9-/),
      'old.csv',
    ]);
    expect(listing[1]).toMatchObject({ file_path: join(dir, 'old.csv'), file_size_bytes: 4 });
    expect(await store.list(1)).toHaveLength(1);
  });

  it('removes only stale temp files', async () => {
    const store = new ExportStore(dir);
    await writeDefault(store, new Uint8Array([1]));
    const stale = join(dir, '.toggl-report-tmp-stale');
    const fresh = join(dir, '.toggl-report-tmp-fresh');
    await writeFile(stale, 'x');
    await writeFile(fresh, 'x');
    await utimes(stale, new Date(2000, 0, 1), new Date(2000, 0, 1));

    await store.cleanStaleTempFiles();

    const names = await readdir(dir);
    expect(names).not.toContain('.toggl-report-tmp-stale');
    expect(names).toContain('.toggl-report-tmp-fresh');
  });
});

describe('countCsvRows', () => {
  const count = (text: string) => countCsvRows(new TextEncoder().encode(text));

  it('counts data rows excluding the header', () => {
    expect(count('')).toBe(0);
    expect(count('a,b\n')).toBe(0);
    expect(count('a,b\n1,2\n3,4')).toBe(2);
    expect(count('a,b\r\n1,2\r\n\r\n3,4\r\n')).toBe(2);
  });

  it('keeps quoted newlines inside one record', () => {
    expect(count('a,b\n"multi\nline",2\n3,"x\r\ny"\n')).toBe(2);
  });
});
