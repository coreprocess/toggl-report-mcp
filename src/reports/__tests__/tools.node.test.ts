/**
 * End-to-end tests for the report tools: a real McpServer over an in-memory transport,
 * a real client with an injected fake fetch, and a real store on a temp directory —
 * verifying request paths, per-format body filtering, workspace resolution, structured
 * errors and file output.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';
import { ExportStore } from '#store/store';
import { TogglClient } from '#toggl/client';
import { WorkspaceResolver } from '#toggl/workspaces';
import { registerDetailedTools } from '../detailed.contract.ts';
import { registerFileTools } from '../files.contract.ts';
import type { ReportToolContext } from '../filters.contract.ts';
import { registerSavedTools } from '../saved.contract.ts';
import { registerSummaryTools } from '../summary.contract.ts';
import { registerWeeklyTools } from '../weekly.contract.ts';

/** Base of all Reports API URLs under the fake origin. */
const REPORTS = 'https://t.test/reports/api/v3';

/** Smallest body that passes the PDF signature check. */
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 fake');

/** One recorded HTTP call made through the fake fetch. */
interface RecordedCall {
  url: string;
  method: string | undefined;
  body: Record<string, unknown> | undefined;
}

/** Everything one test case needs: the connected MCP client and the recorded HTTP calls. */
interface Harness {
  mcp: Client;
  calls: RecordedCall[];
  dir: string;
}

/** Shape of a tool result as seen by the MCP client. */
interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string; uri?: string; mimeType?: string }[];
  structuredContent?: Record<string, unknown>;
}

/** Queued fake responses; each test pushes what its tool call should receive. */
let responses: Response[];

let harness: Harness;

beforeEach(async () => {
  responses = [];
  harness = await createHarness(777);
});

afterEach(async () => {
  await harness.mcp.close();
  await rm(harness.dir, { recursive: true, force: true });
});

/** Wires real server, client and store with a fake network and connects an MCP client. */
async function createHarness(defaultWorkspaceId: number | undefined): Promise<Harness> {
  const calls: RecordedCall[] = [];

  // Real Toggl client over a recording fake fetch.
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error('fake fetch ran out of responses');
    }
    return Promise.resolve(response);
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), 'toggl-report-mcp-tools-'));
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  const client = new TogglClient({
    apiToken: 't',
    baseUrl: 'https://t.test',
    requestTimeoutMs: 5000,
    maxResponseBytes: 1024 * 1024,
    minRequestIntervalMs: 0,
    fetchImpl,
  });
  const context: ReportToolContext = {
    server,
    client,
    store: new ExportStore(dir),
    workspaces: new WorkspaceResolver({ client, defaultWorkspaceId }),
  };
  registerDetailedTools(context);
  registerSummaryTools(context);
  registerWeeklyTools(context);
  registerSavedTools(context);
  registerFileTools(context);

  // Connect an MCP client through a linked in-memory transport pair.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

  return { mcp, calls, dir };
}

/** Calls a tool and returns the typed result. */
async function callTool(
  target: Harness,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await target.mcp.callTool({ name, arguments: args })) as ToolResult;
}

/** Parses the structured error payload of an `isError` result. */
function readError(result: ToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0]?.text ?? '{}');
}

describe('report tools', () => {
  it('registers every tool', async () => {
    const { tools } = await harness.mcp.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'export_detailed_report',
      'export_saved_report',
      'export_summary_report',
      'export_weekly_report',
      'get_detailed_totals',
      'get_project_summary',
      'get_summary_report',
      'get_weekly_report',
      'list_project_user_summaries',
      'list_report_exports',
      'load_saved_report',
      'search_detailed_time_entries',
    ]);
  });

  it('exports a csv weekly report, stripping pdf-only options from the body', async () => {
    responses.push(new Response('user,mon\nalice,1\nbob,2\n', { status: 200 }));

    const result = await callTool(harness, 'export_weekly_report', {
      workspace_id: 123,
      format: 'csv',
      start_date: '2026-01-01',
      end_date: '2026-01-31',
      date_format: 'YYYY-MM-DD',
      logo_url: 'https://example.test/logo.png',
      grouping: 'projects',
    });

    // The request hits the csv endpoint without the pdf-only fields.
    const call = harness.calls[0];
    assert(call, 'expected one HTTP call');
    expect(call.url).toBe(`${REPORTS}/workspace/123/weekly/time_entries.csv`);
    expect(call.body).toEqual({
      start_date: '2026-01-01',
      end_date: '2026-01-31',
      grouping: 'projects',
    });

    // The file lands in the store and the result describes and links it.
    const structured = result.structuredContent;
    assert(structured, 'expected structured content');
    expect(structured).toMatchObject({
      format: 'csv',
      report_type: 'weekly',
      workspace_id: 123,
      requested_date_range: { start_date: '2026-01-01', end_date: '2026-01-31' },
      row_count: 2,
    });
    const filePath = String(structured.file_path);
    expect(filePath).toContain('weekly-123-2026-01-01-2026-01-31');
    expect(await readFile(filePath, 'utf8')).toBe('user,mon\nalice,1\nbob,2\n');
    expect(result.content[1]).toMatchObject({ type: 'resource_link', mimeType: 'text/csv' });
    expect(result.content[1]?.uri).toMatch(/^file:\/\//);
  });

  it('keeps pdf-only options and honours a caller filename', async () => {
    responses.push(new Response(PDF_BYTES, { status: 200 }));

    const result = await callTool(harness, 'export_weekly_report', {
      workspace_id: 123,
      format: 'pdf',
      start_date: '2026-01-01',
      date_format: 'YYYY-MM-DD',
      logo_url: 'https://example.test/logo.png',
      filename: 'january',
    });

    expect(harness.calls[0]?.url).toBe(`${REPORTS}/workspace/123/weekly/time_entries.pdf`);
    expect(harness.calls[0]?.body).toEqual({
      start_date: '2026-01-01',
      date_format: 'YYYY-MM-DD',
      logo_url: 'https://example.test/logo.png',
    });
    expect(result.structuredContent?.file_path).toBe(join(harness.dir, 'january.pdf'));
    expect(result.structuredContent).not.toHaveProperty('row_count');
  });

  it('exports a saved report by token without a workspace', async () => {
    responses.push(new Response(PDF_BYTES, { status: 200 }));

    const result = await callTool(harness, 'export_saved_report', {
      report_token: 'ab/c',
      format: 'pdf',
    });

    expect(harness.calls[0]?.url).toBe(`${REPORTS}/shared/ab%2Fc/pdf`);
    expect(result.structuredContent).toMatchObject({
      report_type: 'saved',
      workspace_id: null,
      requested_date_range: { start_date: null, end_date: null },
    });
    expect(String(result.structuredContent?.file_path)).toContain('saved-ab_c-');
  });

  it('returns detailed search data with pagination cursors', async () => {
    responses.push(
      new Response(JSON.stringify([{ user_id: 1 }]), {
        status: 200,
        headers: { 'X-Next-ID': '900', 'X-Next-Row-Number': '51' },
      }),
    );

    const result = await callTool(harness, 'search_detailed_time_entries', {
      workspace_id: 123,
      start_date: '2026-01-01',
      page_size: 50,
    });

    expect(result.structuredContent).toEqual({
      data: [{ user_id: 1 }],
      next_id: '900',
      next_row_number: '51',
    });
  });

  it('falls back to the configured default workspace without discovery', async () => {
    responses.push(new Response(JSON.stringify({ total_seconds: 1 }), { status: 200 }));

    await callTool(harness, 'get_detailed_totals', { start_date: '2026-01-01' });

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.url).toBe(`${REPORTS}/workspace/777/search/time_entries/totals`);
  });

  it('rejects impossible dates and reversed ranges before calling Toggl', async () => {
    const invalid = await callTool(harness, 'get_summary_report', { start_date: '2026-02-30' });
    expect(invalid.isError).toBe(true);

    const reversed = await callTool(harness, 'get_summary_report', {
      start_date: '2026-02-10',
      end_date: '2026-02-01',
    });
    expect(readError(reversed)).toMatchObject({ error: true, code: 'INVALID_REQUEST' });
    expect(harness.calls).toHaveLength(0);
  });

  it('reports paid-plan gating as a structured FEATURE_UNAVAILABLE error', async () => {
    responses.push(new Response('Payment required', { status: 402 }));

    const result = await callTool(harness, 'export_summary_report', {
      format: 'csv',
      start_date: '2026-01-01',
    });

    const error = readError(result);
    expect(error).toMatchObject({ error: true, code: 'FEATURE_UNAVAILABLE' });
    expect(String(error.message)).toContain('CSV export of the summary report');
  });

  it('lists earlier exports newest first', async () => {
    responses.push(new Response(PDF_BYTES, { status: 200 }));
    await callTool(harness, 'export_saved_report', { report_token: 'tok', format: 'pdf' });

    const result = await callTool(harness, 'list_report_exports', {});

    expect(result.structuredContent?.export_dir).toBe(harness.dir);
    const files = result.structuredContent?.files as { filename: string }[];
    expect(files).toHaveLength(1);
    expect(files[0]?.filename).toMatch(/^saved-tok-.*\.pdf$/);
  });
});

describe('workspace resolution without a default', () => {
  let bare: Harness;

  beforeEach(async () => {
    bare = await createHarness(undefined);
  });

  afterEach(async () => {
    await bare.mcp.close();
    await rm(bare.dir, { recursive: true, force: true });
  });

  it('auto-resolves a sole workspace and caches the discovery', async () => {
    responses.push(
      new Response(JSON.stringify([{ id: 555, name: 'Solo' }]), { status: 200 }),
      new Response(JSON.stringify({ week: [] }), { status: 200 }),
      new Response(JSON.stringify({ week: [] }), { status: 200 }),
    );

    // First call discovers the sole workspace via the Track API, then hits the report.
    await callTool(bare, 'get_weekly_report', { start_date: '2026-01-01' });
    expect(bare.calls.map((call) => call.url)).toEqual([
      'https://t.test/api/v9/me/workspaces',
      `${REPORTS}/workspace/555/weekly/time_entries`,
    ]);
    expect(bare.calls[0]?.method).toBe('GET');

    // The second call reuses the cached discovery instead of listing again.
    await callTool(bare, 'get_weekly_report', { start_date: '2026-01-02' });
    expect(bare.calls).toHaveLength(3);
    expect(bare.calls[2]?.url).toBe(`${REPORTS}/workspace/555/weekly/time_entries`);
  });

  it('shares one workspace discovery between concurrent calls', async () => {
    responses.push(
      new Response(JSON.stringify([{ id: 555, name: 'Solo' }]), { status: 200 }),
      new Response(JSON.stringify({ week: [] }), { status: 200 }),
      new Response(JSON.stringify({ week: [] }), { status: 200 }),
    );

    await Promise.all([
      callTool(bare, 'get_weekly_report', { start_date: '2026-01-01' }),
      callTool(bare, 'get_weekly_report', { start_date: '2026-01-02' }),
    ]);

    const discoveries = bare.calls.filter((call) => call.url.endsWith('/me/workspaces'));
    expect(discoveries).toHaveLength(1);
    expect(bare.calls).toHaveLength(3);
  });

  it('lists the available workspaces when the account has several', async () => {
    responses.push(
      new Response(
        JSON.stringify([
          { id: 111, name: 'Acme' },
          { id: 222, name: 'Personal' },
        ]),
        { status: 200 },
      ),
    );

    const result = await callTool(bare, 'get_weekly_report', { start_date: '2026-01-01' });

    const error = readError(result);
    expect(error.code).toBe('WORKSPACE_REQUIRED');
    expect(String(error.message)).toMatch(/111 \(Acme\), 222 \(Personal\)/);
    expect(error.available_workspaces).toEqual([
      { id: 111, name: 'Acme' },
      { id: 222, name: 'Personal' },
    ]);
  });

  it('enriches an auth failure on an explicit workspace with the accessible ones', async () => {
    responses.push(
      new Response('Forbidden', { status: 403 }),
      new Response(JSON.stringify([{ id: 555, name: 'Solo' }]), { status: 200 }),
    );

    const result = await callTool(bare, 'get_weekly_report', {
      workspace_id: 999,
      start_date: '2026-01-01',
    });

    expect(readError(result)).toMatchObject({
      code: 'AUTH_FAILED',
      available_workspaces: [{ id: 555, name: 'Solo' }],
    });
  });
});
