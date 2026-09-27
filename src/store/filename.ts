/**
 * Filename rules for exports: caller-supplied names are reduced to a safe basename that works
 * on every common filesystem, and generated names carry a sortable UTC timestamp.
 */

import { Buffer } from 'node:buffer';
import { ToolError } from '#errors/errors';

/** Device names Windows reserves regardless of extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Byte budget (not UTF-16 units); common filesystems cap names at 255 bytes. */
const MAX_BASENAME_BYTES = 120;

/**
 * Sanitizes a caller-supplied filename to a safe basename with the given extension. Fails with
 * INVALID_FILENAME rather than silently producing a name the caller did not ask for.
 */
export function sanitizeFilename(input: string, extension: string): string {
  // Drop control characters, path separators and characters invalid on Windows (":" would
  // create an alternate data stream), plus trailing dots/spaces Windows cannot represent.
  let name = stripTrailingDotsAndSpaces(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    input.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[/\\<>:"|?*]/g, ''),
  );
  if (name.includes('..')) {
    throw createInvalidFilenameError(input, 'Filename must not contain ".."');
  }

  // The extension is enforced, so a caller-supplied matching one is dropped first.
  const wanted = `.${extension}`;
  if (name.toLowerCase().endsWith(wanted)) {
    name = stripTrailingDotsAndSpaces(name.slice(0, -wanted.length));
  }

  // Cap by encoded length at a character boundary; check reserved names afterwards so
  // truncation cannot resurrect one.
  while (Buffer.byteLength(name, 'utf8') > MAX_BASENAME_BYTES) {
    name = Array.from(name).slice(0, -1).join('');
  }
  name = stripTrailingDotsAndSpaces(name);
  if (name === '') {
    throw createInvalidFilenameError(input, 'Filename is empty after sanitization');
  }
  if (WINDOWS_RESERVED.test(name.split('.')[0] ?? name)) {
    throw createInvalidFilenameError(input, 'Filename is a reserved device name');
  }
  return `${name}${wanted}`;
}

/** Builds `<baseName>-<YYYYMMDD-HHMMSS>.<extension>` from the current UTC time. */
export function buildTimestampedFilename(baseName: string, extension: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${baseName}-${stamp}.${extension}`;
}

/** Trims whitespace and removes trailing dots and spaces. */
function stripTrailingDotsAndSpaces(name: string): string {
  return name
    .trim()
    .replace(/[. ]+$/g, '')
    .trim();
}

/** Creates the INVALID_FILENAME error quoting the original input. */
function createInvalidFilenameError(input: string, reason: string): ToolError {
  return new ToolError('INVALID_FILENAME', `${reason}: ${JSON.stringify(input)}`, {});
}
