/** Tests for the Toggl client: auth, error mapping, retries, timeouts, cancellation, file checks. */

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { type CallContext, TogglClient } from '../client.contract.ts';

/** Records requests and replays the given responses (or failures) in order. */
function createFakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error('fake fetch ran out of responses');
    }
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Builds an unpaced client wired to the given fetch under a test base URL. */
function createClient(
  fetchImpl: typeof fetch,
  overrides: {
    apiToken?: string | undefined;
    requestTimeoutMs?: number;
    maxResponseBytes?: number;
  } = {},
): TogglClient {
  return new TogglClient({
    apiToken: 'apiToken' in overrides ? overrides.apiToken : 'my-token',
    baseUrl: 'https://t.test',
    requestTimeoutMs: overrides.requestTimeoutMs ?? 5000,
    maxResponseBytes: overrides.maxResponseBytes ?? 1024 * 1024,
    minRequestIntervalMs: 0,
    fetchImpl,
  });
}

/** Creates a fresh, never-aborted call context. */
function createCall(client: TogglClient, signal = new AbortController().signal): CallContext {
  return client.createCallContext(signal);
}

describe('TogglClient', () => {
  it('sends basic auth, JSON body and returns body plus pagination headers', async () => {
    const { fetchImpl, calls } = createFakeFetch([
      new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { 'X-Next-ID': '42', 'X-Next-Row-Number': '51' },
      }),
    ]);
    const client = createClient(fetchImpl);

    const result = await client.requestJson({
      path: '/workspace/7/search/time_entries',
      body: { start_date: '2026-01-01' },
      call: createCall(client),
    });

    const call = calls[0];
    expect(call?.url).toBe('https://t.test/reports/api/v3/workspace/7/search/time_entries');
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('my-token:api_token').toString('base64')}`,
    );
    expect(JSON.parse(String(call?.init.body))).toEqual({ start_date: '2026-01-01' });
    expect(result).toEqual({ body: [{ id: 1 }], nextId: '42', nextRowNumber: '51' });
  });

  it('fails with CONFIG_ERROR without contacting Toggl when no token is set', async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const client = createClient(fetchImpl, { apiToken: undefined });

    await expect(
      client.requestJson({ path: '/x', body: {}, call: createCall(client) }),
    ).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, 'AUTH_FAILED'],
    [403, 'AUTH_FAILED'],
    [404, 'NOT_FOUND'],
    [400, 'INVALID_REQUEST'],
  ])('maps HTTP %i to %s without retrying', async (status, code) => {
    const { fetchImpl, calls } = createFakeFetch([new Response('nope', { status })]);
    const client = createClient(fetchImpl);

    await expect(
      client.requestJson({ path: '/x', body: {}, call: createCall(client) }),
    ).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(1);
  });

  it('distinguishes 402 quota exhaustion from paid-feature gating', async () => {
    const { fetchImpl } = createFakeFetch([
      new Response('quota', { status: 402, headers: { 'X-Toggl-Quota-Resets-In': '120' } }),
      new Response('paid', { status: 402 }),
    ]);
    const client = createClient(fetchImpl);
    const download = () =>
      client.requestFile({
        path: '/x.csv',
        body: {},
        format: 'csv',
        feature: 'CSV export of the summary report',
        call: createCall(client),
      });

    await expect(download()).rejects.toMatchObject({
      code: 'TOGGL_QUOTA_EXCEEDED',
      extra: { resets_in_seconds: 120 },
    });
    await expect(download()).rejects.toMatchObject({
      code: 'FEATURE_UNAVAILABLE',
      message: expect.stringContaining('CSV export of the summary report'),
    });
  });

  it('retries 429 and 5xx, then succeeds', async () => {
    const { fetchImpl, calls } = createFakeFetch([
      new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } }),
      new Response('boom', { status: 502 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);
    const client = createClient(fetchImpl);

    const result = await client.requestJson({ path: '/x', body: {}, call: createCall(client) });

    expect(calls).toHaveLength(3);
    expect(result.body).toEqual({ ok: true });
  });

  it('gives up with RATE_LIMITED when Retry-After exceeds the retry budget', async () => {
    const { fetchImpl, calls } = createFakeFetch([
      new Response('slow down', { status: 429, headers: { 'Retry-After': '3600' } }),
    ]);
    const client = createClient(fetchImpl);

    await expect(
      client.requestJson({ path: '/x', body: {}, call: createCall(client) }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', extra: { retry_after_ms: 3_600_000 } });
    expect(calls).toHaveLength(1);
  });

  it('reports TIMEOUT when Toggl does not answer in time', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const client = createClient(fetchImpl, { requestTimeoutMs: 20 });

    await expect(
      client.requestJson({ path: '/x', body: {}, call: createCall(client) }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('reports CANCELLED when the tool call is aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        controller.abort();
      })) as unknown as typeof fetch;
    const client = createClient(fetchImpl);

    await expect(
      client.requestJson({ path: '/x', body: {}, call: createCall(client, controller.signal) }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects oversized responses', async () => {
    const { fetchImpl } = createFakeFetch([new Response(new Uint8Array(64), { status: 200 })]);
    const client = createClient(fetchImpl, { maxResponseBytes: 16 });

    await expect(
      client.requestFile({
        path: '/x.pdf',
        body: {},
        format: 'pdf',
        feature: 'export',
        call: createCall(client),
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('validates file signatures so error pages are never saved as reports', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 body');
    const { fetchImpl } = createFakeFetch([
      new Response(pdf, { status: 200 }),
      new Response('<html>error</html>', { status: 200 }),
      new Response('{"error":true}', { status: 200 }),
    ]);
    const client = createClient(fetchImpl);
    const download = (format: 'pdf' | 'csv') =>
      client.requestFile({
        path: '/x',
        body: {},
        format,
        feature: 'export',
        call: createCall(client),
      });

    expect(Buffer.from(await download('pdf'))).toEqual(Buffer.from(pdf));
    await expect(download('pdf')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(download('csv')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('lists workspaces via a GET to the Track API, reduced to id and name', async () => {
    const { fetchImpl, calls } = createFakeFetch([
      new Response(
        JSON.stringify([
          { id: 11, name: 'Acme', organization_id: 5 },
          { id: 22, name: 'Personal', organization_id: 6 },
        ]),
        { status: 200 },
      ),
    ]);
    const client = createClient(fetchImpl);

    const workspaces = await client.listWorkspaces(createCall(client));

    expect(calls[0]?.url).toBe('https://t.test/api/v9/me/workspaces');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.body).toBeUndefined();
    expect(workspaces).toEqual([
      { id: 11, name: 'Acme' },
      { id: 22, name: 'Personal' },
    ]);
  });
});
