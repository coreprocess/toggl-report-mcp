import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ToolError } from './errors.js';

export type ExportFormat = 'pdf' | 'csv';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_BASENAME_LENGTH = 120;
const MAX_COLLISION_SUFFIX = 1000;

/**
 * Sanitizes a caller-supplied filename to a safe basename with the correct
 * extension. Throws INVALID_FILENAME rather than silently producing a
 * different name than the caller asked for.
 */
export function sanitizeFilename(input: string, extension: ExportFormat): string {
  let name = input
    // NUL + control characters, then path separators.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '')
    .trim()
    // Windows cannot represent trailing dots/spaces.
    .replace(/[. ]+$/g, '')
    .trim();

  if (name.includes('..')) {
    throw new ToolError('INVALID_FILENAME', `Filename must not contain "..": ${JSON.stringify(input)}`);
  }

  const wanted = `.${extension}`;
  if (name.toLowerCase().endsWith(wanted)) {
    name = name.slice(0, -wanted.length);
  }
  name = name.replace(/[. ]+$/g, '').trim();

  if (name === '') {
    throw new ToolError('INVALID_FILENAME', `Filename is empty after sanitization: ${JSON.stringify(input)}`);
  }
  if (WINDOWS_RESERVED.test(name)) {
    throw new ToolError('INVALID_FILENAME', `Filename is a reserved device name: ${JSON.stringify(input)}`);
  }
  if (name.length > MAX_BASENAME_LENGTH) {
    name = name.slice(0, MAX_BASENAME_LENGTH).replace(/[. ]+$/g, '');
  }
  return `${name}${wanted}`;
}

export function defaultFilename(
  reportType: string,
  startDate: string,
  endDate: string | undefined,
  extension: ExportFormat,
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const range = endDate ? `${startDate}_${endDate}` : startDate;
  return `toggl-${reportType}-${range}-${stamp}.${extension}`;
}

/**
 * Writes bytes into the export directory atomically and race-free:
 * the payload is written to a private temp file first, then hard-linked into
 * the final name so the OS arbitrates collisions (EEXIST -> numeric suffix).
 * Readers never observe a partially written file, and the temp file is
 * removed on every path, including failures.
 */
export async function writeExportFile(
  exportDir: string,
  filename: string,
  bytes: Buffer,
): Promise<string> {
  const resolved = path.resolve(exportDir, filename);
  if (!resolved.startsWith(exportDir + path.sep)) {
    throw new ToolError(
      'INVALID_FILENAME',
      `Filename escapes the export directory: ${JSON.stringify(filename)}`,
    );
  }

  const tmp = path.join(exportDir, `.toggl-report-tmp-${crypto.randomBytes(8).toString('hex')}`);
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
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
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
 * Counts CSV data rows (excluding the header row). Quoted fields may contain
 * newlines, so newlines inside quotes are not record separators.
 */
export function countCsvRows(bytes: Buffer): number {
  const text = bytes.toString('utf8');
  let records = 0;
  let inQuotes = false;
  let hasContent = false;
  for (const ch of text) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      hasContent = true;
    } else if (ch === '\n' && !inQuotes) {
      if (hasContent) records++;
      hasContent = false;
    } else if (ch !== '\r') {
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
    const stat = await fsp.lstat(filePath);
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
