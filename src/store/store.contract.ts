/**
 * Local export store: persists downloaded report files into the configured directory without
 * ever overwriting an existing file or exposing a partially written one, and lists what is
 * there so a model can find earlier exports.
 */

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join, parse, resolve } from 'node:path';
import { ToolError } from '#errors/errors';
import { buildTimestampedFilename, sanitizeFilename } from './filename.ts';

/** Most collision suffixes (`-1`, `-2`, …) tried before giving up. */
const MAX_COLLISION_SUFFIX = 1000;

/** Prefix of private temp files; the leading dot hides them from casual listings. */
const TEMP_FILE_PREFIX = '.toggl-report-tmp-';

/** Temp files older than this cannot belong to a live write and are removed at startup. */
const STALE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

/** Extensions considered exports when listing; unrelated files in the folder stay hidden. */
const EXPORT_EXTENSIONS = new Set(['.pdf', '.csv', '.xlsx']);

/** Filesystem errors meaning "hard links unsupported here" (exFAT, FAT32, some mounts). */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV']);

/** Location and size of one persisted export file. */
export interface StoredExport {
  /** Absolute path of the written file. */
  path: string;
  /** File size in bytes. */
  bytes: number;
}

/** One export file found in the directory. */
export interface ExportListing {
  /** Basename of the file. */
  filename: string;
  /** Absolute path of the file. */
  file_path: string;
  /** File size in bytes. */
  file_size_bytes: number;
  /** Last modification time as an ISO timestamp. */
  modified_at: string;
}

/**
 * Writes report exports into a configurable directory. The directory is ensured on every
 * write — not just at startup — so the server keeps working when it is deleted mid-session.
 */
export class ExportStore {
  /** Absolute export directory. */
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = resolve(dir);
  }

  /** Absolute export directory. */
  get dir(): string {
    return this.#dir;
  }

  /**
   * Persists one export atomically. A caller-supplied filename is sanitized; otherwise a
   * timestamped name is derived from the base name. Collisions get a numeric suffix.
   */
  async write(params: {
    filename: string | undefined;
    defaultBaseName: string;
    extension: string;
    data: Uint8Array;
  }): Promise<StoredExport> {
    const { extension, data } = params;
    const filename =
      params.filename === undefined
        ? buildTimestampedFilename(params.defaultBaseName, extension)
        : sanitizeFilename(params.filename, extension);

    // Write privately to a temp file first so readers never observe a partial export.
    await this.#run(filename, () => mkdir(this.#dir, { recursive: true, mode: 0o700 }));
    const temp = join(this.#dir, `${TEMP_FILE_PREFIX}${randomBytes(8).toString('hex')}`);
    try {
      await this.#run(filename, () => writeFile(temp, data, { flag: 'wx', mode: 0o600 }));

      // Publish under the first free name; the OS arbitrates collisions via EEXIST.
      const { name, ext } = parse(filename);
      for (let attempt = 0; attempt <= MAX_COLLISION_SUFFIX; attempt++) {
        const target = join(this.#dir, attempt === 0 ? filename : `${name}-${attempt}${ext}`);
        if (await this.#publish(temp, target)) {
          return { path: target, bytes: data.byteLength };
        }
      }
      throw new ToolError(
        'FILE_WRITE_ERROR',
        `Could not find a free filename for ${filename} after ${MAX_COLLISION_SUFFIX} attempts.`,
        {},
      );
    } finally {
      await unlink(temp).catch(ignoreMissingFile);
    }
  }

  /** Lists export files newest first; symlinks and other file types are never included. */
  async list(limit: number): Promise<ExportListing[]> {
    // A directory that does not exist (yet) simply holds no exports.
    const entries = await readdir(this.#dir, { withFileTypes: true }).catch((err: unknown): [] => {
      ignoreMissingFile(err);
      return [];
    });

    // Stat regular export files; ones deleted between readdir and lstat are skipped.
    const listings: { mtimeMs: number; listing: ExportListing }[] = [];
    for (const entry of entries) {
      if (!(entry.isFile() && EXPORT_EXTENSIONS.has(extname(entry.name).toLowerCase()))) {
        continue;
      }
      const filePath = join(this.#dir, entry.name);
      const stat = await lstat(filePath).catch((err: unknown) => ignoreMissingFile(err));
      if (stat !== undefined) {
        listings.push({
          mtimeMs: stat.mtimeMs,
          listing: {
            filename: entry.name,
            file_path: filePath,
            file_size_bytes: stat.size,
            modified_at: stat.mtime.toISOString(),
          },
        });
      }
    }
    listings.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return listings.slice(0, limit).map((entry) => entry.listing);
  }

  /** Removes temp files left behind by a crashed run; young ones may belong to a live instance. */
  async cleanStaleTempFiles(): Promise<void> {
    const entries = await readdir(this.#dir).catch((err: unknown): string[] => {
      ignoreMissingFile(err);
      return [];
    });
    const cutoff = Date.now() - STALE_TEMP_MAX_AGE_MS;
    for (const entry of entries) {
      if (!entry.startsWith(TEMP_FILE_PREFIX)) {
        continue;
      }
      const file = join(this.#dir, entry);
      const stat = await lstat(file).catch((err: unknown) => ignoreMissingFile(err));
      if (stat?.isFile() && stat.mtimeMs < cutoff) {
        await unlink(file).catch(ignoreMissingFile);
      }
    }
  }

  /** Links the temp file to the target; false when the name is taken. */
  async #publish(temp: string, target: string): Promise<boolean> {
    try {
      await link(temp, target);
      return true;
    } catch (err) {
      if (readErrorCode(err) === 'EEXIST') {
        return false;
      }
      if (!LINK_UNSUPPORTED.has(readErrorCode(err) ?? '')) {
        throw createWriteError(target, err);
      }
    }

    // No hard links on this filesystem: an exclusive copy keeps the no-overwrite guarantee.
    try {
      await copyFile(temp, target, constants.COPYFILE_EXCL);
    } catch (err) {
      if (readErrorCode(err) === 'EEXIST') {
        return false;
      }
      throw createWriteError(target, err);
    }

    // A copy gets umask-derived permissions; restore the private mode of the temp file.
    try {
      await chmod(target, 0o600);
    } catch (err) {
      throw createWriteError(target, err);
    }
    return true;
  }

  /** Runs a filesystem step, reporting filesystem failures as FILE_WRITE_ERROR. */
  async #run(filename: string, step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (err) {
      throw createWriteError(filename, err);
    }
  }
}

/**
 * Counts CSV data rows, excluding the header. Scans bytes directly (quote/CR/LF never occur
 * inside UTF-8 multibyte sequences); quoted fields may contain newlines, and CRLF, LF and bare
 * CR separators are all recognised. Unbalanced quotes yield a best-effort count.
 */
export function countCsvRows(bytes: Uint8Array): number {
  let records = 0;
  let inQuotes = false;
  let hasContent = false;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x22) {
      inQuotes = !inQuotes;
      hasContent = true;
    } else if (!inQuotes && (byte === 0x0a || byte === 0x0d)) {
      // A CRLF pair is one separator; blank lines are not records.
      if (byte === 0x0d && bytes[i + 1] === 0x0a) {
        i++;
      }
      if (hasContent) {
        records++;
      }
      hasContent = false;
    } else {
      hasContent = true;
    }
  }
  if (hasContent) {
    records++;
  }
  return Math.max(0, records - 1);
}

/** Returns the errno code of a filesystem error, if any. */
function readErrorCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

/** Swallows only ENOENT (the file vanished, which is fine); rethrows everything else. */
function ignoreMissingFile(err: unknown): undefined {
  if (readErrorCode(err) !== 'ENOENT') {
    throw err;
  }
  return undefined;
}

/** Wraps a filesystem error as FILE_WRITE_ERROR; non-filesystem errors are rethrown as is. */
function createWriteError(name: string, err: unknown): ToolError {
  if (readErrorCode(err) === undefined || !(err instanceof Error)) {
    throw err;
  }
  return new ToolError(
    'FILE_WRITE_ERROR',
    `Could not write export file ${name}: ${err.message}`,
    {},
  );
}
