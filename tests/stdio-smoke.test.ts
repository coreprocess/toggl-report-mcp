import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CSV_BODY = 'User,Project,Duration\nalice,acme,1:00\nbob,acme,2:00\n';
const PDF_BODY = '%PDF-1.7\nfake pdf payload\n%%EOF\n';
/** Requests against this workspace ID get a 402 + quota headers from the stub. */
const QUOTA_WORKSPACE_ID = 40200;

interface Stub {
  server: http.Server;
  baseUrl: string;
  workspaces: { id: number; name: string }[];
  requests: { method: string; url: string; body: string }[];
}

function startStub(): Promise<Stub> {
  const stub: Partial<Stub> & { workspaces: { id: number; name: string }[] } = {
    workspaces: [{ id: 123, name: 'Test Workspace' }],
    requests: [],
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      stub.requests!.push({ method: req.method ?? '', url: req.url ?? '', body });
      if (req.method === 'GET' && req.url === '/api/v9/me/workspaces') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(stub.workspaces));
        return;
      }
      const exportMatch = /^\/reports\/api\/v3\/workspace\/(\d+)\/(search|summary|weekly)\/time_entries\.(csv|pdf)$/.exec(
        req.url ?? '',
      );
      if (req.method === 'POST' && exportMatch) {
        if (Number(exportMatch[1]) === QUOTA_WORKSPACE_ID) {
          res.statusCode = 402;
          res.setHeader('x-toggl-quota-remaining', '0');
          res.setHeader('x-toggl-quota-resets-in', '900');
          res.end();
          return;
        }
        if (exportMatch[3] === 'pdf') {
          res.setHeader('content-type', 'application/pdf');
          res.end(PDF_BODY);
        } else {
          res.setHeader('content-type', 'text/csv');
          res.setHeader('content-disposition', 'attachment; filename="toggl_stub_export.csv"');
          res.end(CSV_BODY);
        }
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        workspaces: stub.workspaces,
        requests: stub.requests!,
      });
    });
  });
}

/**
 * Hermetic child environment: inherits the process env for PATH/HOME/etc.,
 * but strips all TOGGL_* variables first so a developer's local settings
 * (or a .env file) cannot silently change test behavior.
 */
function serverEnv(stub: Stub, exportDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('TOGGL_')) env[key] = value;
  }
  env.TOGGL_API_KEY = 'smoke-test-token';
  env.TOGGL_EXPORT_DIR = exportDir;
  env.TOGGL_API_BASE_URL = stub.baseUrl;
  return env;
}

// The smoke tests run the BUILT server (dist/index.js, produced by the
// pretest build) so packaging problems — a missing shebang, broken NodeNext
// import extensions — fail the suite, not the first real user.
const serverArgs = [path.join(projectRoot, 'dist', 'index.js')];

function parseErrorPayload(result: unknown): Record<string, unknown> {
  const content = (result as { content: { text: string }[] }).content;
  return JSON.parse(content[0]!.text);
}

describe('stdio smoke test (built server against a local HTTP stub)', () => {
  let stub: Stub;
  let exportDir: string;
  let client: Client;

  beforeAll(async () => {
    stub = await startStub();
    exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toggl-mcp-smoke-'));
    client = new Client({ name: 'smoke-test-client', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: serverArgs,
      cwd: projectRoot,
      env: serverEnv(stub, exportDir),
      stderr: 'pipe',
    });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
    stub.server.close();
    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  it('lists the four tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'toggl_export_detailed_report',
      'toggl_export_summary_report',
      'toggl_export_weekly_report',
      'toggl_list_report_exports',
    ]);
    const listTool = tools.find((tool) => tool.name === 'toggl_list_report_exports');
    expect(listTool?.annotations?.readOnlyHint).toBe(true);
  });

  it('exports a detailed CSV to disk (auto-resolving the single workspace)', async () => {
    const result = await client.callTool({
      name: 'toggl_export_detailed_report',
      arguments: { format: 'csv', start_date: '2026-07-01', end_date: '2026-07-31' },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      file_path: string;
      row_count: number;
      workspace_id: number;
    };
    expect(structured.workspace_id).toBe(123);
    expect(structured.row_count).toBe(2);
    expect(fs.readFileSync(structured.file_path, 'utf8')).toBe(CSV_BODY);
    // Content-Disposition filename from the stub is honored, with a
    // timestamp appended to keep re-exports distinguishable.
    expect(path.basename(structured.file_path)).toMatch(/^toggl_stub_export-\d{8}-\d{6}\.csv$/);

    const exportRequest = stub.requests.find((r) => r.url.includes('search/time_entries.csv'));
    expect(exportRequest).toBeDefined();
    expect(JSON.parse(exportRequest!.body)).toEqual({
      start_date: '2026-07-01',
      end_date: '2026-07-31',
    });

    const links = (result.content as { type: string; uri?: string }[]).filter(
      (block) => block.type === 'resource_link',
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.uri).toBe(`file://${structured.file_path}`);
  });

  it('exports a weekly PDF to disk', async () => {
    const result = await client.callTool({
      name: 'toggl_export_weekly_report',
      arguments: { format: 'pdf', start_date: '2026-07-20' },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { file_path: string; row_count?: number };
    expect(structured.row_count).toBeUndefined();
    const bytes = fs.readFileSync(structured.file_path);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('rejects an invalid date range without calling the API', async () => {
    const before = stub.requests.length;
    const result = await client.callTool({
      name: 'toggl_export_summary_report',
      arguments: { format: 'csv', start_date: '2026-07-31', end_date: '2026-07-01' },
    });
    expect(result.isError).toBe(true);
    const payload = parseErrorPayload(result);
    expect(payload.error).toBe(true);
    expect(payload.code).toBe('INVALID_REQUEST');
    expect(stub.requests.length).toBe(before);
  });

  it('maps a 402 quota response to TOGGL_QUOTA_EXCEEDED over the wire', async () => {
    const result = await client.callTool({
      name: 'toggl_export_detailed_report',
      arguments: {
        format: 'csv',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        workspace_id: QUOTA_WORKSPACE_ID,
      },
    });
    expect(result.isError).toBe(true);
    const payload = parseErrorPayload(result);
    expect(payload.error).toBe(true);
    expect(payload.code).toBe('TOGGL_QUOTA_EXCEEDED');
    expect(payload.resets_in_seconds).toBe(900);
  });

  it('lists the exported files, newest first', async () => {
    const result = await client.callTool({ name: 'toggl_list_report_exports', arguments: {} });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      export_dir: string;
      files: { filename: string }[];
    };
    expect(structured.files.length).toBeGreaterThanOrEqual(2);
  });
});

describe('workspace resolution over stdio', () => {
  it('returns WORKSPACE_REQUIRED with the workspace listing when several are accessible', async () => {
    const stub = await startStub();
    stub.workspaces.push({ id: 456, name: 'Second Workspace' });
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toggl-mcp-smoke-multi-'));
    const client = new Client({ name: 'smoke-test-client', version: '0.0.0' });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: serverArgs,
          cwd: projectRoot,
          env: serverEnv(stub, exportDir),
          stderr: 'pipe',
        }),
      );
      const result = await client.callTool({
        name: 'toggl_export_detailed_report',
        arguments: { format: 'csv', start_date: '2026-07-01', end_date: '2026-07-31' },
      });
      expect(result.isError).toBe(true);
      const payload = parseErrorPayload(result);
      expect(payload.error).toBe(true);
      expect(payload.code).toBe('WORKSPACE_REQUIRED');
      expect(payload.available_workspaces).toEqual([
        { id: 123, name: 'Test Workspace' },
        { id: 456, name: 'Second Workspace' },
      ]);
    } finally {
      await client.close();
      stub.server.close();
      fs.rmSync(exportDir, { recursive: true, force: true });
    }
  });
});

describe('stdout purity', () => {
  it('emits nothing but JSON-RPC on stdout', async () => {
    const stub = await startStub();
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toggl-mcp-purity-'));
    const child = spawn(process.execPath, serverArgs, {
      cwd: projectRoot,
      env: serverEnv(stub, exportDir),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => resolve(out), 10_000);
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes('\n')) {
            clearTimeout(timer);
            resolve(out);
          }
        });
        child.on('error', reject);
        // Give the process a moment to start (and to emit any stray output)
        // before sending the initialize request.
        setTimeout(() => {
          child.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'purity-test', version: '0.0.0' },
              },
            }) + '\n',
          );
        }, 1500);
      });
      const firstLine = stdout.split('\n')[0]!;
      const parsed = JSON.parse(firstLine);
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.id).toBe(1);
      expect(parsed.result?.serverInfo?.name).toBe('toggl-report-mcp');
    } finally {
      child.kill('SIGTERM');
      stub.server.close();
      fs.rmSync(exportDir, { recursive: true, force: true });
    }
  });
});
