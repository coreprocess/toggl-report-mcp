/** Tests for environment parsing: startup-fatal problems fail fast, optional values validate. */

import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.contract.ts';

describe('parseConfig', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'toggl-report-mcp-config-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('parses a fully configured environment', async () => {
    const config = parseConfig({
      TOGGL_API_KEY: ' secret ',
      TOGGL_EXPORT_DIR: root,
      TOGGL_DEFAULT_WORKSPACE_ID: '123',
      TOGGL_API_BASE_URL: 'https://proxy.example.test/toggl/',
      TOGGL_REQUEST_TIMEOUT_MS: '5000',
      TOGGL_MAX_EXPORT_MB: '2',
    });
    expect(config).toEqual({
      apiToken: 'secret',
      exportDir: await realpath(root),
      defaultWorkspaceId: 123,
      apiBaseUrl: 'https://proxy.example.test/toggl',
      requestTimeoutMs: 5000,
      maxResponseBytes: 2 * 1024 * 1024,
    });
  });

  it('applies defaults and the legacy variable names', () => {
    const config = parseConfig({ TOGGL_API_TOKEN: 'legacy', TOGGL_REPORT_MCP_DIR: root });
    expect(config.apiToken).toBe('legacy');
    expect(config.defaultWorkspaceId).toBeUndefined();
    expect(config.apiBaseUrl).toBe('https://api.track.toggl.com');
    expect(config.requestTimeoutMs).toBe(60_000);
    expect(config.maxResponseBytes).toBe(100 * 1024 * 1024);
  });

  it('prefers TOGGL_API_KEY over the aliases', () => {
    const config = parseConfig({
      TOGGL_TOKEN: 'c',
      TOGGL_API_TOKEN: 'b',
      TOGGL_API_KEY: 'a',
      TOGGL_EXPORT_DIR: root,
    });
    expect(config.apiToken).toBe('a');
  });

  it('starts without a token so tools can explain the fix', () => {
    expect(parseConfig({ TOGGL_EXPORT_DIR: root }).apiToken).toBeUndefined();
  });

  it('creates a missing export directory privately', async () => {
    const dir = join(root, 'nested', 'exports');
    parseConfig({ TOGGL_EXPORT_DIR: dir });
    const info = await stat(dir);
    expect(info.isDirectory()).toBe(true);
    expect(info.mode & 0o777).toBe(0o700);
  });

  it('rejects a missing, relative or non-directory export path', async () => {
    expect(() => parseConfig({})).toThrow(/TOGGL_EXPORT_DIR is required/);
    expect(() => parseConfig({ TOGGL_EXPORT_DIR: 'exports' })).toThrow(/absolute path/);
    const file = join(root, 'file.txt');
    await writeFile(file, 'x');
    expect(() => parseConfig({ TOGGL_EXPORT_DIR: file })).toThrow(/TOGGL_EXPORT_DIR/);
  });

  it('rejects invalid numbers', () => {
    for (const value of ['not-a-number', '0', '-5', '1e3', '12abc']) {
      expect(() =>
        parseConfig({ TOGGL_EXPORT_DIR: root, TOGGL_DEFAULT_WORKSPACE_ID: value }),
      ).toThrow(/TOGGL_DEFAULT_WORKSPACE_ID must be a positive integer/);
    }
  });

  it('rejects base URLs that would leak the token or corrupt paths', () => {
    const bad = [
      'http://api.example.test',
      'https://user:pw@api.example.test',
      'https://api.example.test?x=1',
      'not a url',
    ];
    for (const value of bad) {
      expect(() => parseConfig({ TOGGL_EXPORT_DIR: root, TOGGL_API_BASE_URL: value })).toThrow(
        /TOGGL_API_BASE_URL/,
      );
    }
    expect(
      parseConfig({ TOGGL_EXPORT_DIR: root, TOGGL_API_BASE_URL: 'http://127.0.0.1:8080' })
        .apiBaseUrl,
    ).toBe('http://127.0.0.1:8080');
  });
});
