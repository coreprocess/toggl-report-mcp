import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ToolError } from './errors.js';

export type ExportFormat = 'pdf' | 'csv';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Byte budget (not UTF-16 units): common filesystems cap names at 255 bytes. */
const MAX_BASENAME_BYTES = 120;
const MAX_COLLISION_SUFFIX = 1000;
const TEMP_FILE_PREFIX = '.toggl-report-tmp-';
const STALE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

function invalidFilename(input: string, reason: string): ToolError {
  return new ToolError('INVALID_FILENAME', `${reason}: ${JSON.stringify(input)}`);
}

/**
 * Sanitizes a caller-supplied filename to a safe basename with the correct
 * extension. Throws INVALID_FILENAME rather than silently producing a
 * different name than the caller asked for.
 */
export function sanitizeFilename(input: string, extension: ExportFormat): string {
  let name = input
    // NUL + control characters, path separators, then characters invalid on
    // Windows/NTFS (":" would create an alternate data stream).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .trim()
    // Windows cannot represent trailing dots/spaces.
    .replace(/[. ]+$/g, '')
    .trim();

  if (name.includes('..')) {
    throw invalidFilename(input, 'Filename must not contain ".."');
  }

  const wanted = `.${extension}`;
  if (name.toLowerCase().endsWith(wanted)) {
    name = name.slice(0, -wanted.length);
  }
  name = name.replace(/[. ]+$/g, '').trim();

  // Cap by encoded byte length, truncating at a character boundary; run the
  // reserved-name check afterwards so truncation cannot resurrect one.
  while (Buffer.byteLength(name, 'utf8') > MAX_BASENAME_BYTES) {
    name = name.slice(0, -1);
  }
  name = name.replace(/[. ]+$/g, '').trim();

  if (name === '') {
    throw invalidFilename(input, 'Filename is empty after sanitization');
  }
  // Windows reserves device names based on the segment before the first dot
  // ("CON.txt" is just as reserved as "CON").
  const stem = name.split('.')[0] ?? name;
  if (WINDOWS_RESERVED.test(stem)) {
    throw invalidFilename(input, 'Filename is a reserved device name');
  }
  return `${name}${wanted}`;
}

function timestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

export function defaultFilename(
  reportType: string,
  startDate: string,
  endDate: string | undefined,
  extension: ExportFormat,
  now: Date = new Date(),
): string {
  const range = endDate ? `${startDate}_${endDate}` : startDate;
  return `toggl-${reportType}-${range}-${timestamp(now)}.${extension}`;
}

/**
 * Inserts a timestamp before the extension. Used for upstream-suggested
 * (Content-Disposition) names, which are derived from the date range and
 * would otherwise collide on every re-export.
 */
export function appendTimestamp(filename: string, now: Date = new Date()): string {
  const { name, ext } = path.parse(filename);
  return `${name}-${timestamp(now)}${ext}`;
}

/**
 * Writes bytes into the export directory atomically and race-free:
 * the payload is written to a private temp file first, then hard-linked into
 * the final name so the OS arbitrates collisions (EEXIST -> numeric suffix).
 * On filesystems without hard links (exFAT/FAT32, some network mounts) it
 * falls back to an exclusive copy, preserving the no-overwrite guarantee.
 * Readers never observe a partially written file, and the temp file is
 * removed on every path, including failures.
 */
export async function writeExportFile(
  exportDir: string,
  filename: string,
  bytes: Buffer,
): Promise<string> {
  const relative = path.relative(exportDir, path.resolve(exportDir, filename));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new ToolError(
      'INVALID_FILENAME',
      `Filename escapes the export directory: ${JSON.stringify(filename)}`,
    );
  }

  const tmp = path.join(exportDir, `${TEMP_FILE_PREFIX}${crypto.randomBytes(8).toString('hex')}`);
  try {
    await fsp.writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
    const { name, ext } = path.parse(filename);
    for (let attempt = 0; attempt <= MAX_COLLISION_SUFFIX; attempt++) {
      const candidate = attempt === 0 ? filename : `${name}-${attempt}${ext}`;
      const target = path.join(exportDir, candidate);
      try {
        await fsp.link(tmp, target);
        return target;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') continue;
        if (code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS' || code === 'EXDEV') {
          try {
            await fsp.copyFile(tmp, target, fsConstants.COPYFILE_EXCL);
            return target;
          } catch (copyErr) {
            if ((copyErr as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw new ToolError(
              'FILE_WRITE_ERROR',
              `Could not write export file ${candidate}: ${(copyErr as Error).message}`,
            );
          }
        }
        throw new ToolError(
          'FILE_WRITE_ERROR',
          `Could not write export file ${candidate}: ${(err as Error).message}`,
        );
      }
    }
    throw new ToolError(
      'FILE_WRITE_ERROR',
      `Could not find a free filename for ${filename} after ${MAX_COLLISION_SUFFIX} attempts.`,
    );
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

/**
 * Removes temp files left behind by a crashed or killed previous run. Only
 * files old enough to not belong to a concurrently running instance are
 * touched.
 */
export async function cleanStaleTempFiles(
  exportDir: string,
  maxAgeMs: number = STALE_TEMP_MAX_AGE_MS,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(exportDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.startsWith(TEMP_FILE_PREFIX)) continue;
    const file = path.join(exportDir, entry);
    try {
      const stat = await fsp.lstat(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        await fsp.unlink(file);
      }
    } catch {
      // Raced with another process; nothing to do.
    }
  }
}

/**
 * Counts CSV data rows (excluding the header row). Scans the buffer directly
 * (quote/CR/LF bytes cannot occur inside UTF-8 multibyte sequences) to avoid
 * a second full-string copy of large exports. Quoted fields may contain
 * newlines; CRLF, LF, and bare-CR record separators are all recognized.
 * Structurally invalid CSV (an unbalanced quote) yields a best-effort count.
 */
export function countCsvRows(bytes: Buffer): number {
  const QUOTE = 0x22;
  const LF = 0x0a;
  const CR = 0x0d;
  let records = 0;
  let inQuotes = false;
  let hasContent = false;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (byte === QUOTE) {
      inQuotes = !inQuotes;
      hasContent = true;
    } else if (!inQuotes && (byte === LF || byte === CR)) {
      if (byte === CR && bytes[i + 1] === LF) i++;
      if (hasContent) records++;
      hasContent = false;
    } else {
      hasContent = true;
    }
  }
  if (hasContent) records++;
  return Math.max(0, records - 1);
}

export interface ExportListing {
  filename: string;
  file_path: string;
  file_size_bytes: number;
  modified_at: string;
}

/**
 * Lists PDF/CSV files in the export directory, newest first. Symlinks are
 * never followed and files with other extensions are ignored, so pointing
 * TOGGL_EXPORT_DIR at a pre-existing folder does not dump unrelated files
 * into model context.
 */
export async function listExportFiles(exportDir: string, limit: number): Promise<ExportListing[]> {
  const entries = await fsp.readdir(exportDir, { withFileTypes: true });
  const results: ExportListing[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue; // excludes directories and symlinks
    const ext = path.extname(entry.name).toLowerCase();
    if (ext !== '.pdf' && ext !== '.csv') continue;
    const filePath = path.join(exportDir, entry.name);
    let stat;
    try {
      stat = await fsp.lstat(filePath);
    } catch (err) {
      // The file may have been deleted between readdir and lstat.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    results.push({
      filename: entry.name,
      file_path: filePath,
      file_size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    });
  }
  results.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return results.slice(0, limit);
}
