/**
 * Environment-driven configuration for the Toggl Reports MCP server. Problems that make the
 * server unusable (export directory, base URL, numeric limits) fail startup; a missing API
 * token deliberately does not, so tools can explain the fix in-chat instead of the client
 * showing only "server disconnected".
 */

import { accessSync, constants, mkdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** Production origin of the Toggl APIs; the Reports and Track API paths hang off it. */
const DEFAULT_API_BASE_URL = 'https://api.track.toggl.com';

/** Per-attempt HTTP timeout; large PDF exports can take tens of seconds to render. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Download size cap in megabytes, protecting memory and disk from runaway responses. */
const DEFAULT_MAX_EXPORT_MB = 100;

/** Token variables in precedence order; `TOGGL_API_KEY` first to match verygoodplugins/mcp-toggl. */
const TOKEN_VARIABLES = ['TOGGL_API_KEY', 'TOGGL_API_TOKEN', 'TOGGL_TOKEN'] as const;

/** Export directory variables in precedence order; the second is the original name, kept as an alias. */
const EXPORT_DIR_VARIABLES = ['TOGGL_EXPORT_DIR', 'TOGGL_REPORT_MCP_DIR'] as const;

/** A configuration problem that prevents the server from starting. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Runtime configuration resolved from environment variables at startup. */
export interface Config {
  /** Toggl API token for basic auth; undefined makes every Toggl call fail with CONFIG_ERROR. */
  apiToken: string | undefined;
  /** Absolute, real, writable directory that receives exported report files. */
  exportDir: string;
  /** Workspace applied when a tool call omits workspace_id; undefined when not configured. */
  defaultWorkspaceId: number | undefined;
  /** Toggl API origin (optionally with a path prefix) without a trailing slash. */
  apiBaseUrl: string;
  /** Timeout of a single HTTP attempt in milliseconds. */
  requestTimeoutMs: number;
  /** Maximum accepted response size in bytes. */
  maxResponseBytes: number;
}

/** Parses the environment into a Config, creating and checking the export directory. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  return {
    apiToken: readFirst(env, TOKEN_VARIABLES),
    exportDir: prepareExportDir(readFirst(env, EXPORT_DIR_VARIABLES)),
    defaultWorkspaceId: parseOptionalPositiveInteger(env, 'TOGGL_DEFAULT_WORKSPACE_ID'),
    apiBaseUrl: parseBaseUrl(env.TOGGL_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL),
    requestTimeoutMs:
      parseOptionalPositiveInteger(env, 'TOGGL_REQUEST_TIMEOUT_MS') ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxResponseBytes:
      (parseOptionalPositiveInteger(env, 'TOGGL_MAX_EXPORT_MB') ?? DEFAULT_MAX_EXPORT_MB) *
      1024 *
      1024,
  };
}

/** Returns the first non-blank value among the given variables, trimmed. */
function readFirst(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

/** Validates the API base URL; the basic-auth header must never cross cleartext to a remote host. */
function parseBaseUrl(raw: string): string {
  // Reject anything that is not a URL at all.
  if (!URL.canParse(raw)) {
    throw new ConfigError(`TOGGL_API_BASE_URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  const url = new URL(raw);

  // HTTPS everywhere; plain HTTP only towards loopback (local stubs and tests).
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new ConfigError(
      'TOGGL_API_BASE_URL must use HTTPS; plain HTTP is only allowed for loopback addresses.',
    );
  }

  // Paths are appended verbatim, so credentials, queries and fragments would corrupt requests.
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(
      'TOGGL_API_BASE_URL must be a plain origin (optionally with a path): credentials, query strings and fragments are not allowed.',
    );
  }
  return url.toString().replace(/\/+$/, '');
}

/** Ensures the export directory exists, is a directory and is writable; returns its real path. */
function prepareExportDir(raw: string | undefined): string {
  // Required and absolute: MCP clients start stdio servers in an unpredictable working directory.
  if (raw === undefined) {
    throw new ConfigError(
      'TOGGL_EXPORT_DIR is required: set it to the absolute path of the directory where report exports should be written.',
    );
  }
  if (!isAbsolute(raw)) {
    throw new ConfigError(
      `TOGGL_EXPORT_DIR must be an absolute path, got ${JSON.stringify(raw)}; relative paths would resolve against an unpredictable working directory.`,
    );
  }

  // Create it private when missing (existing directories keep their mode), then check it.
  const real = runFsCheck(raw, 'could not be prepared', () => {
    mkdirSync(raw, { recursive: true, mode: 0o700 });
    return realpathSync(raw);
  });
  if (!runFsCheck(raw, 'could not be inspected', () => statSync(real).isDirectory())) {
    throw new ConfigError(`TOGGL_EXPORT_DIR (${raw}) is not a directory.`);
  }
  runFsCheck(raw, 'is not writable', () => accessSync(real, constants.W_OK));
  return real;
}

/** Runs one filesystem step of the export directory check, reporting failures as ConfigError. */
function runFsCheck<T>(dir: string, failure: string, step: () => T): T {
  try {
    return step();
  } catch (err) {
    // Only filesystem errors (which carry a code) are configuration problems; rethrow the rest.
    if (!(err instanceof Error && 'code' in err)) {
      throw err;
    }
    throw new ConfigError(`TOGGL_EXPORT_DIR (${dir}) ${failure}: ${err.message}`);
  }
}

/** Parses an optional positive integer variable; blank counts as unset. */
function parseOptionalPositiveInteger(
  env: Record<string, string | undefined>,
  name: string,
): number | undefined {
  // Unset or blank means "use the default".
  const raw = env[name]?.trim();
  if (!raw) {
    return undefined;
  }

  // Digits only, so "1e3", "12abc" and "-5" are rejected rather than coerced.
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value <= 0 || !Number.isSafeInteger(value)) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  return value;
}
