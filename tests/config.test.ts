import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigError,
  DEFAULT_API_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  loadConfig,
  prepareExportDir,
  resolveApiToken,
  validateBaseUrl,
} from '../src/config.js';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toggl-mcp-config-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveApiToken', () => {
  it('prefers TOGGL_API_KEY and accepts both aliases', () => {
    expect(
      resolveApiToken({ TOGGL_API_KEY: 'a', TOGGL_API_TOKEN: 'b', TOGGL_TOKEN: 'c' }),
    ).toBe('a');
    expect(resolveApiToken({ TOGGL_API_TOKEN: 'b', TOGGL_TOKEN: 'c' })).toBe('b');
    expect(resolveApiToken({ TOGGL_TOKEN: 'c' })).toBe('c');
  });

  it('trims whitespace and treats empty values as unset', () => {
    expect(resolveApiToken({ TOGGL_API_KEY: '  padded  ' })).toBe('padded');
    expect(resolveApiToken({ TOGGL_API_KEY: '   ', TOGGL_TOKEN: 'c' })).toBe('c');
    expect(resolveApiToken({})).toBeUndefined();
  });
});

describe('validateBaseUrl', () => {
  it('accepts HTTPS URLs and strips trailing slashes', () => {
    expect(validateBaseUrl('https://api.track.toggl.com/')).toBe('https://api.track.toggl.com');
  });

  it('accepts plain HTTP only for loopback addresses', () => {
    expect(validateBaseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(validateBaseUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(() => validateBaseUrl('http://api.track.toggl.com')).toThrow(ConfigError);
  });

  it('rejects invalid URLs', () => {
    expect(() => validateBaseUrl('not a url')).toThrow(ConfigError);
  });
});

describe('prepareExportDir', () => {
  it('rejects missing and relative paths', () => {
    expect(() => prepareExportDir(undefined)).toThrow(ConfigError);
    expect(() => prepareExportDir('')).toThrow(ConfigError);
    expect(() => prepareExportDir('relative/exports')).toThrow(ConfigError);
  });

  it('creates missing directories with private permissions', () => {
    const parent = tmpDir();
    const target = path.join(parent, 'nested', 'exports');
    const resolved = prepareExportDir(target);
    expect(fs.statSync(resolved).isDirectory()).toBe(true);
    expect(fs.statSync(resolved).mode & 0o777).toBe(0o700);
  });

  it('returns the realpath of the directory', () => {
    const dir = tmpDir();
    expect(prepareExportDir(dir)).toBe(fs.realpathSync(dir));
  });
});

describe('loadConfig', () => {
  it('loads a full configuration', () => {
    const dir = tmpDir();
    const config = loadConfig({
      TOGGL_API_KEY: 'token',
      TOGGL_EXPORT_DIR: dir,
      TOGGL_DEFAULT_WORKSPACE_ID: '123',
      TOGGL_REQUEST_TIMEOUT_MS: '5000',
    });
    expect(config.apiToken).toBe('token');
    expect(config.exportDir).toBe(fs.realpathSync(dir));
    expect(config.defaultWorkspaceId).toBe(123);
    expect(config.apiBaseUrl).toBe(DEFAULT_API_BASE_URL);
    expect(config.requestTimeoutMs).toBe(5000);
  });

  it('applies defaults and tolerates a missing token', () => {
    const config = loadConfig({ TOGGL_EXPORT_DIR: tmpDir() });
    expect(config.apiToken).toBeUndefined();
    expect(config.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(config.defaultWorkspaceId).toBeUndefined();
  });

  it('rejects a non-numeric default workspace id', () => {
    expect(() =>
      loadConfig({ TOGGL_EXPORT_DIR: tmpDir(), TOGGL_DEFAULT_WORKSPACE_ID: 'abc' }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ TOGGL_EXPORT_DIR: tmpDir(), TOGGL_DEFAULT_WORKSPACE_ID: '0' }),
    ).toThrow(ConfigError);
  });

  it('rejects an invalid timeout', () => {
    expect(() =>
      loadConfig({ TOGGL_EXPORT_DIR: tmpDir(), TOGGL_REQUEST_TIMEOUT_MS: '-5' }),
    ).toThrow(ConfigError);
  });
});
