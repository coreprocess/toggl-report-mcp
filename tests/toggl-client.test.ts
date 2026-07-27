import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../src/config.js';
import { ToolError } from '../src/errors.js';
import { TogglClient } from '../src/toggl-client.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiToken: 'test-token',
    exportDir: '/tmp/unused',
    apiBaseUrl: 'https://api.example.test',
    requestTimeoutMs: 5000,
    ...overrides,
  };
}

type MockResponseInit = {
  status?: number;
  body?: string | Buffer;
  headers?: Record<string, string>;
};

function mockResponse({ status = 200, body = '', headers = {} }: MockResponseInit): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
    status,
    headers,
  });
}

const CSV_BODY = 'User,Project,Duration\nalice,acme,1:00\nbob,acme,2:00\n';
const PDF_BODY = '%PDF-1.7 fake pdf content';

function stubFetch(...responses: MockResponseInit[]) {
  const fn = vi.fn();
  for (const response of responses) {
    fn.mockResolvedValueOnce(mockResponse(response));
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function expectToolError(promise: Promise<unknown>, code: string): Promise<ToolError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe(code);
    return err as ToolError;
  }
  throw new Error(`Expected ToolError with code ${code}, but the promise resolved.`);
}

describe('exportReport', () => {
  it('builds the correct URL, auth header, and JSON body', async () => {
    const fetchMock = stubFetch({ body: CSV_BODY });
    const client = new TogglClient(makeConfig());

    const result = await client.exportReport({
      reportType: 'detailed',
      format: 'csv',
      workspaceId: 123,
      body: { start_date: '2026-07-01', end_date: '2026-07-31' },
    });

    expect(result.bytes.toString()).toBe(CSV_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/reports/api/v3/workspace/123/search/time_entries.csv');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ start_date: '2026-07-01', end_date: '2026-07-31' });
    const expectedAuth = 'Basic ' + Buffer.from('test-token:api_token').toString('base64');
    expect(init.headers.Authorization).toBe(expectedAuth);
  });

  it.each([
    ['summary', 'https://api.example.test/reports/api/v3/workspace/9/summary/time_entries.pdf'],
    ['weekly', 'https://api.example.test/reports/api/v3/workspace/9/weekly/time_entries.pdf'],
  ] as const)('uses the %s endpoint', async (reportType, expectedUrl) => {
    const fetchMock = stubFetch({ body: PDF_BODY });
    const client = new TogglClient(makeConfig());
    await client.exportReport({
      reportType,
      format: 'pdf',
      workspaceId: 9,
      body: { start_date: '2026-07-01' },
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(expectedUrl);
  });

  it('parses the Content-Disposition filename', async () => {
    stubFetch({
      body: CSV_BODY,
      headers: { 'content-disposition': 'attachment; filename="toggl_report.csv"' },
    });
    const client = new TogglClient(makeConfig());
    const result = await client.exportReport({
      reportType: 'detailed',
      format: 'csv',
      workspaceId: 1,
      body: {},
    });
    expect(result.contentDispositionFilename).toBe('toggl_report.csv');
  });

  it('rejects non-PDF bodies for pdf exports', async () => {
    stubFetch({ body: 'Something went wrong' });
    const client = new TogglClient(makeConfig());
    await expectToolError(
      client.exportReport({ reportType: 'detailed', format: 'pdf', workspaceId: 1, body: {} }),
      'INVALID_RESPONSE',
    );
  });

  it('rejects JSON/HTML bodies for csv exports and empty bodies', async () => {
    stubFetch({ body: '{"error":"nope"}' });
    const client = new TogglClient(makeConfig());
    await expectToolError(
      client.exportReport({ reportType: 'detailed', format: 'csv', workspaceId: 1, body: {} }),
      'INVALID_RESPONSE',
    );

    stubFetch({ body: '' });
    await expectToolError(
      client.exportReport({ reportType: 'detailed', format: 'csv', workspaceId: 1, body: {} }),
      'INVALID_RESPONSE',
    );
  });

  it('maps 400 to INVALID_REQUEST with the upstream message', async () => {
    stubFetch({ status: 400, body: '"At least one parameter must be set"' });
    const client = new TogglClient(makeConfig());
    const err = await expectToolError(
      client.exportReport({ reportType: 'detailed', format: 'csv', workspaceId: 1, body: {} }),
      'INVALID_REQUEST',
    );
    expect(err.message).toContain('At least one parameter must be set');
  });

  it('maps 402 with quota headers to TOGGL_QUOTA_EXCEEDED', async () => {
    stubFetch({
      status: 402,
      headers: { 'x-toggl-quota-remaining': '0', 'x-toggl-quota-resets-in': '1200' },
    });
    const client = new TogglClient(makeConfig());
    const err = await expectToolError(
      client.exportReport({ reportType: 'detailed', format: 'csv', workspaceId: 1, body: {} }),
      'TOGGL_QUOTA_EXCEEDED',
    );
    expect(err.extra.resets_in_seconds).toBe(1200);
  });

  it('maps 402 without quota headers to FEATURE_UNAVAILABLE naming the feature', async () => {
    stubFetch({ status: 402 });
    const client = new TogglClient(makeConfig());
    const err = await expectToolError(
      client.exportReport({ reportType: 'detailed', format: 'csv', workspaceId: 1, body: {} }),
      'FEATURE_UNAVAILABLE',
    );
    expect(err.message).toContain('CSV export of the detailed report');
  });

  it('maps 403 to AUTH_FAILED and enriches it with available workspaces', async () => {
    stubFetch(
      { status: 403 },
      { body: JSON.stringify([{ id: 1, name: 'One' }, { id: 2, name: 'Two' }]) },
    );
    const client = new TogglClient(makeConfig());
    const err = await expectToolError(
      client.exportReport({ reportType: 'detailed', format: 'csv', workspaceId: 999, body: {} }),
      'AUTH_FAILED',
    );
    expect(err.extra.available_workspaces).toEqual([
      { id: 1, name: 'One' },
      { id: 2, name: 'Two' },
    ]);
  });

  it('keeps AUTH_FAILED when workspace enrichment also fails', async () => {
    stubFetch({ status: 403 }, { status: 403 });
    const client = new TogglClient(makeConfig());
    const err = await expectToolError(
      client.exportReport({ reportType: 'detailed', format: 'csv', workspaceId: 999, body: {} }),
      'AUTH_FAILED',
    );
    expect(err.extra.available_workspaces).toBeUndefined();
  });

  it('retries a 429 and succeeds', async () => {
    const fetchMock = stubFetch({ status: 429, headers: { 'retry-after': '1' } }, { body: CSV_BODY });
    const client = new TogglClient(makeConfig());
    const result = await client.exportReport({
      reportType: 'detailed',
      format: 'csv',
      workspaceId: 1,
      body: {},
    });
    expect(result.bytes.toString()).toBe(CSV_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up with RATE_LIMITED when 429s persist', async () => {
    stubFetch({ status: 429 }, { status: 429 }, { status: 429 });
    const client = new TogglClient(makeConfig());
    await expectToolError(
      client.exportReport({ reportType: 'detailed', format: 'csv', workspaceId: 1, body: {} }),
      'RATE_LIMITED',
    );
  });

  it('reports CONFIG_ERROR when no token is configured', async () => {
    stubFetch({ body: CSV_BODY });
    const client = new TogglClient(makeConfig({ apiToken: undefined }));
    await expectToolError(
      client.exportReport({ reportType: 'detailed', format: 'csv', workspaceId: 1, body: {} }),
      'CONFIG_ERROR',
    );
  });

  it('serializes concurrent requests through the rate-limit queue', async () => {
    const starts: number[] = [];
    const fn = vi.fn(async () => {
      starts.push(Date.now());
      return mockResponse({ body: CSV_BODY });
    });
    vi.stubGlobal('fetch', fn);
    const client = new TogglClient(makeConfig());
    await Promise.all([
      client.exportReport({ reportType: 'detailed', format: 'csv', workspaceId: 1, body: {} }),
      client.exportReport({ reportType: 'detailed', format: 'csv', workspaceId: 1, body: {} }),
    ]);
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(900);
  });
});

describe('getWorkspaces', () => {
  it('caches the workspace list', async () => {
    const fetchMock = stubFetch({ body: JSON.stringify([{ id: 1, name: 'One' }]) });
    const client = new TogglClient(makeConfig());
    expect(await client.getWorkspaces()).toEqual([{ id: 1, name: 'One' }]);
    expect(await client.getWorkspaces()).toEqual([{ id: 1, name: 'One' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example.test/api/v9/me/workspaces');
  });

  it('does not cache failures', async () => {
    const fetchMock = stubFetch({ status: 500 }, { status: 500 }, { status: 500 });
    const client = new TogglClient(makeConfig({ requestTimeoutMs: 500 }));
    await expectToolError(client.getWorkspaces(), 'UPSTREAM_ERROR');
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('resolveWorkspaceId', () => {
  it('prefers the explicit argument without any API call', async () => {
    const fetchMock = stubFetch();
    const client = new TogglClient(makeConfig({ defaultWorkspaceId: 42 }));
    expect(await client.resolveWorkspaceId(7, 'test')).toBe(7);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the configured default without any API call', async () => {
    const fetchMock = stubFetch();
    const client = new TogglClient(makeConfig({ defaultWorkspaceId: 42 }));
    expect(await client.resolveWorkspaceId(undefined, 'test')).toBe(42);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auto-picks a single accessible workspace', async () => {
    stubFetch({ body: JSON.stringify([{ id: 11, name: 'Solo' }]) });
    const client = new TogglClient(makeConfig());
    expect(await client.resolveWorkspaceId(undefined, 'test')).toBe(11);
  });

  it('errors with the workspace listing when several are accessible', async () => {
    stubFetch({
      body: JSON.stringify([
        { id: 123456, name: 'Acme Inc' },
        { id: 789012, name: 'Personal' },
      ]),
    });
    const client = new TogglClient(makeConfig());
    const err = await expectToolError(
      client.resolveWorkspaceId(undefined, 'the detailed report export'),
      'WORKSPACE_REQUIRED',
    );
    expect(err.message).toBe(
      'Workspace ID required for the detailed report export. Set TOGGL_DEFAULT_WORKSPACE_ID ' +
        'or provide workspace_id. Available workspaces: 123456 (Acme Inc), 789012 (Personal)',
    );
    expect(err.extra.available_workspaces).toEqual([
      { id: 123456, name: 'Acme Inc' },
      { id: 789012, name: 'Personal' },
    ]);
    expect(err.extra.tip).toContain('TOGGL_DEFAULT_WORKSPACE_ID');
  });

  it('errors when no workspaces are accessible', async () => {
    stubFetch({ body: '[]' });
    const client = new TogglClient(makeConfig());
    const err = await expectToolError(client.resolveWorkspaceId(undefined, 'test'), 'WORKSPACE_REQUIRED');
    expect(err.message).toContain('no Toggl workspaces were returned');
  });
});
