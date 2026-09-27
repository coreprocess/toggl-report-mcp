/**
 * Tool-boundary helpers shared by the report tools: turning ToolErrors into structured
 * `isError` results, enriching auth failures on workspace-scoped calls, validating date
 * ranges, and running the download-and-store flow of every export tool.
 */

import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ToolError } from '#errors/errors';
import { countCsvRows } from '#store/store';
import type { CallContext } from '#toggl/client';
import type { ExportFormat, ReportToolContext } from './filters.contract.ts';

/** MIME types announced on the resource link of an exported file. */
const MIME_TYPES: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Report families that can be exported. */
type ReportType = 'detailed' | 'summary' | 'weekly' | 'saved';

/** Structured output of every export tool. */
export const exportOutputShape = {
  file_path: z.string().describe('Absolute path of the written file'),
  file_size_bytes: z.number().int().describe('Size of the written file in bytes'),
  format: z.enum(['pdf', 'csv', 'xlsx']).describe('File format of the export'),
  report_type: z.enum(['detailed', 'summary', 'weekly', 'saved']).describe('Report family'),
  workspace_id: z
    .number()
    .int()
    .nullable()
    .describe('Workspace the report was generated for; null for saved reports'),
  requested_date_range: z
    .object({ start_date: z.string().nullable(), end_date: z.string().nullable() })
    .describe('Date range as requested; null bounds were left to Toggl defaults'),
  row_count: z.number().int().optional().describe('Data rows excluding the header (csv only)'),
};

/** Annotations of every export tool: writes a new local file, calls the Toggl API. */
export const EXPORT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Annotations of every JSON report tool: reads from the Toggl API only. */
export const READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true };

/**
 * Runs a tool body, reporting ToolErrors as structured `isError` results the calling model
 * can act on. Unexpected errors are rethrown; the SDK reports them as generic tool errors.
 */
export async function runTool(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (err) {
    if (!(err instanceof ToolError)) {
      throw err;
    }
    return {
      isError: true,
      content: [
        { type: 'text', text: JSON.stringify({ error: true, ...err.toPayload() }, null, 2) },
      ],
    };
  }
}

/** Wraps a report payload as an MCP tool result: pretty-printed text plus structured content. */
export function toStructuredResult(envelope: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
  };
}

/** Rejects a date range whose end lies before its start; ISO dates compare lexically. */
export function assertDateOrder(range: {
  start_date: string | undefined;
  end_date: string | undefined;
}): void {
  const { start_date, end_date } = range;
  if (start_date !== undefined && end_date !== undefined && end_date < start_date) {
    throw new ToolError(
      'INVALID_REQUEST',
      `end_date (${end_date}) must not be before start_date (${start_date}).`,
      {},
    );
  }
}

/** Fetches a workspace-scoped JSON report; auth failures list the accessible workspaces. */
export async function fetchWorkspaceJson(params: {
  context: ReportToolContext;
  path: string;
  body: Record<string, unknown>;
  call: CallContext;
}) {
  const { context, call } = params;
  try {
    return await context.client.requestJson({ path: params.path, body: params.body, call });
  } catch (err) {
    throw await context.workspaces.enrichAuthError({ error: err, call });
  }
}

/**
 * Downloads an export, stores it without overwriting anything and reports the file as JSON
 * plus a resource link. Workspace-scoped auth failures list the accessible workspaces.
 */
export async function runExport(params: {
  context: ReportToolContext;
  call: CallContext;
  path: string;
  body: Record<string, unknown>;
  format: ExportFormat;
  reportType: ReportType;
  workspaceId: number | null;
  filename: string | undefined;
  defaultBaseName: string;
  dateRange: { start_date: string | undefined; end_date: string | undefined };
}): Promise<CallToolResult> {
  const { context, call, format, reportType } = params;

  // Download; a 403 on a workspace-scoped call is often a wrong workspace_id.
  let data: Uint8Array;
  try {
    data = await context.client.requestFile({
      path: params.path,
      body: params.body,
      format,
      feature: `${format.toUpperCase()} export of the ${reportType} report`,
      call,
    });
  } catch (err) {
    throw params.workspaceId === null
      ? err
      : await context.workspaces.enrichAuthError({ error: err, call });
  }

  // A cancelled call must not leave a file behind for a client that is already gone.
  if (call.signal.aborted) {
    throw new ToolError('CANCELLED', 'The tool call was cancelled.', {});
  }

  // Persist and describe the file.
  const stored = await context.store.write({
    filename: params.filename,
    defaultBaseName: params.defaultBaseName,
    extension: format,
    data,
  });
  const output: Record<string, unknown> = {
    file_path: stored.path,
    file_size_bytes: stored.bytes,
    format,
    report_type: reportType,
    workspace_id: params.workspaceId,
    requested_date_range: {
      start_date: params.dateRange.start_date ?? null,
      end_date: params.dateRange.end_date ?? null,
    },
  };
  if (format === 'csv') {
    output.row_count = countCsvRows(data);
  }
  return {
    content: [
      { type: 'text', text: JSON.stringify(output, null, 2) },
      {
        type: 'resource_link',
        uri: pathToFileURL(stored.path).href,
        name: basename(stored.path),
        mimeType: MIME_TYPES[format],
        description: `Exported Toggl ${reportType} report (${format.toUpperCase()})`,
      },
    ],
    structuredContent: output,
  };
}
