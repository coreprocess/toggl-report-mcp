import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  /** Undefined when no token env var is set; tools then return CONFIG_ERROR. */
  apiToken?: string;
  /** Realpath'd absolute export directory. */
  exportDir: string;
  defaultWorkspaceId?: number;
  /** Base URL without trailing slash. */
  apiBaseUrl: string;
  /** Per-attempt HTTP timeout in milliseconds. */
  requestTimeoutMs: number;
}

/** Fatal configuration problem: the server refuses to start. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_API_BASE_URL = 'https://api.track.toggl.com';
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Same precedence as verygoodplugins/mcp-toggl: TOGGL_API_KEY preferred. */
const TOKEN_VARS = ['TOGGL_API_KEY', 'TOGGL_API_TOKEN', 'TOGGL_TOKEN'] as const;

export function resolveApiToken(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of TOKEN_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function validateBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`TOGGL_API_BASE_URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new ConfigError(
      'TOGGL_API_BASE_URL must use HTTPS; plain HTTP is only allowed for loopback addresses ' +
        '(the Basic-auth header must never travel over cleartext to a remote host).',
    );
  }
  return url.toString().replace(/\/+$/, '');
}

export function prepareExportDir(raw: string | undefined): string {
  if (!raw || raw.trim() === '') {
    throw new ConfigError(
      'TOGGL_EXPORT_DIR is required: set it to the absolute path of the directory ' +
        'where report exports should be written.',
    );
  }
  const dir = raw.trim();
  if (!path.isAbsolute(dir)) {
    throw new ConfigError(
      `TOGGL_EXPORT_DIR must be an absolute path, got ${JSON.stringify(dir)}. ` +
        'MCP clients start stdio servers with an unpredictable working directory, ' +
        'so relative paths would resolve somewhere unintended.',
    );
  }
  try {
    // Newly created directories are private; existing ones are left untouched.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new ConfigError(
      `TOGGL_EXPORT_DIR (${dir}) could not be created: ${(err as Error).message}`,
    );
  }
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch (err) {
    throw new ConfigError(
      `TOGGL_EXPORT_DIR (${dir}) could not be resolved: ${(err as Error).message}`,
    );
  }
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) {
    throw new ConfigError(`TOGGL_EXPORT_DIR (${dir}) is not a directory.`);
  }
  try {
    fs.accessSync(real, fs.constants.W_OK);
  } catch {
    throw new ConfigError(`TOGGL_EXPORT_DIR (${dir}) is not writable.`);
  }
  return real;
}

function parseDefaultWorkspaceId(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new ConfigError(
      `TOGGL_DEFAULT_WORKSPACE_ID must be a positive integer, got ${JSON.stringify(raw)}.`,
    );
  }
  return Number(trimmed);
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_REQUEST_TIMEOUT_MS;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(
      `TOGGL_REQUEST_TIMEOUT_MS must be a positive integer (milliseconds), got ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}

/**
 * Loads and validates configuration. Throws ConfigError for problems that make
 * the server unusable (export directory, workspace-id default, base URL,
 * timeout). A missing API token is deliberately NOT fatal: the server starts
 * and tools return an actionable CONFIG_ERROR the user can read in-chat,
 * instead of the client showing only "server disconnected".
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    apiToken: resolveApiToken(env),
    exportDir: prepareExportDir(env.TOGGL_EXPORT_DIR),
    defaultWorkspaceId: parseDefaultWorkspaceId(env.TOGGL_DEFAULT_WORKSPACE_ID),
    apiBaseUrl: validateBaseUrl(env.TOGGL_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL),
    requestTimeoutMs: parseTimeout(env.TOGGL_REQUEST_TIMEOUT_MS),
  };
}
