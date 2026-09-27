import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { ToolError } from '../errors.js';
import {
  appendTimestamp,
  countCsvRows,
  defaultFilename,
  sanitizeFilename,
  writeExportFile,
  type ExportFormat,
} from '../exports.js';
import type { ReportType, TogglClient } from '../toggl-client.js';

export interface ToolContext {
  client: TogglClient;
  exportDir: string;
}

/**
 * In-flight export operations, tracked so shutdown can wait (briefly) for
 * them to finish and clean up their temp files.
 */
export const inflightOperations = new Set<Promise<unknown>>();

function tracked<T>(promise: Promise<T>): Promise<T> {
  inflightOperations.add(promise);
  promise.finally(() => inflightOperations.delete(promise)).catch(() => {});
  return promise;
}

export const FILE_TOOL_DISCLAIMER =
  'Writes a file to disk and returns its path; use this when the user wants a PDF/CSV report file ' +
  'they can keep or send. For in-chat report data, use the mcp-toggl tools instead.';

function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isRealCalendarDate, 'Not a real calendar date');

/** Toggl's `[null]` convention selects entries with no project/client/tag/user. */
const idFilterSchema = (noun: string) =>
  z
    .array(z.union([z.number().int().positive(), z.null()]))
    .optional()
    .describe(`Filter by ${noun} IDs. Use [null] to select entries with no ${noun}.`);

export const commonExportInputs = {
  format: z.enum(['pdf', 'csv']).describe('Export file format.'),
  workspace_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Toggl workspace ID. Optional: falls back to TOGGL_DEFAULT_WORKSPACE_ID, then auto-detects ' +
        'when exactly one workspace is accessible. With multiple accessible workspaces and no ' +
        'value, the tool returns a WORKSPACE_REQUIRED error listing the available workspaces.',
    ),
  project_ids: idFilterSchema('project'),
  client_ids: idFilterSchema('client'),
  tag_ids: idFilterSchema('tag'),
  user_ids: z
    .array(z.number().int().positive())
    .optional()
    .describe('Filter by user IDs.'),
  billable: z
    .boolean()
    .optional()
    .describe('Filter: true for billable entries only, false for non-billable only. Omit for both.'),
  description: z.string().optional().describe('Filter by time-entry description.'),
  filename: z
    .string()
    .optional()
    .describe(
      'Optional output filename (basename only, no directories). The correct extension is enforced. ' +
        'Existing files are never overwritten; a numeric suffix is appended on collision.',
    ),
};

export const exportOutputShape = {
  file_path: z.string().describe('Absolute path of the written export file.'),
  file_size_bytes: z.number(),
  format: z.enum(['pdf', 'csv']),
  report_type: z.enum(['detailed', 'summary', 'weekly']),
  workspace_id: z.number(),
  requested_date_range: z
    .object({
      start_date: z.string(),
      end_date: z.string().nullable(),
    })
    .describe('The date range that was requested (not independently verified from file contents).'),
  row_count: z
    .number()
    .optional()
    .describe('Number of CSV data rows (excluding the header). Only present for CSV exports.'),
};

export const exportAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export function assertDateOrder(startDate: string, endDate: string | undefined): void {
  if (endDate !== undefined && endDate < startDate) {
    throw new ToolError(
      'INVALID_REQUEST',
      `end_date (${endDate}) must not be before start_date (${startDate}).`,
    );
  }
}

export interface RunExportParams {
  reportType: ReportType;
  format: ExportFormat;
  workspaceId: number | undefined;
  startDate: string;
  endDate: string | undefined;
  filename: string | undefined;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

export function runExport(ctx: ToolContext, params: RunExportParams): Promise<CallToolResult> {
  return tracked(runExportInner(ctx, params));
}

async function runExportInner(
  ctx: ToolContext,
  params: RunExportParams,
): Promise<CallToolResult> {
  const { reportType, format, startDate, endDate, signal } = params;
  // One wall-clock budget for the whole tool call (workspace lookup, export,
  // retries), so stacked waits cannot outlive the client's tool-call timeout.
  const deadline = ctx.client.createCallDeadline();

  const workspaceId = await ctx.client.resolveWorkspaceId(
    params.workspaceId,
    `the ${reportType} report export`,
    signal,
    deadline,
  );

  const { bytes, contentDispositionFilename } = await ctx.client.exportReport({
    reportType,
    format,
    workspaceId,
    body: params.body,
    signal,
    deadline,
    // Spend a fresh workspace lookup on AUTH_FAILED only when the workspace
    // ID was supplied by the caller or the env default: those are the cases
    // where "wrong workspace" is the likely cause. Auto-detected workspaces
    // already populated the cache.
    enrichAuthErrors: params.workspaceId !== undefined || ctx.client.hasDefaultWorkspace,
  });

  let filename: string;
  if (params.filename) {
    filename = sanitizeFilename(params.filename, format);
  } else if (contentDispositionFilename) {
    try {
      // Toggl derives the suggested name from the date range, so repeats
      // would collide; a timestamp keeps names distinguishable.
      filename = sanitizeFilename(appendTimestamp(contentDispositionFilename), format);
    } catch {
      filename = defaultFilename(reportType, startDate, endDate, format);
    }
  } else {
    filename = defaultFilename(reportType, startDate, endDate, format);
  }

  if (signal?.aborted) {
    throw new ToolError('CANCELLED', 'The tool call was cancelled.');
  }
  const filePath = await writeExportFile(ctx.exportDir, filename, bytes);

  const structured: Record<string, unknown> = {
    file_path: filePath,
    file_size_bytes: bytes.length,
    format,
    report_type: reportType,
    workspace_id: workspaceId,
    requested_date_range: { start_date: startDate, end_date: endDate ?? null },
  };
  if (format === 'csv') {
    structured.row_count = countCsvRows(bytes);
  }

  return {
    content: [
      { type: 'text', text: JSON.stringify(structured, null, 2) },
      {
        type: 'resource_link',
        uri: pathToFileURL(filePath).href,
        name: path.basename(filePath),
        mimeType: format === 'pdf' ? 'application/pdf' : 'text/csv',
        description: `Exported Toggl ${reportType} report (${format.toUpperCase()})`,
      },
    ],
    structuredContent: structured,
  };
}

export function toErrorResult(err: unknown): CallToolResult {
  // Flat envelope ({ error: true, code, message, ... }) mirroring
  // mcp-toggl's errorPayload() shape, so a model that learned to recover
  // from one server's errors handles the other identically.
  const payload =
    err instanceof ToolError
      ? { error: true, ...err.toPayload() }
      : {
          error: true,
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : String(err),
        };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Wraps a tool handler so every expected failure becomes an `isError` result
 * with a structured JSON payload instead of an MCP protocol error.
 */
export function withErrorHandling<Args, Extra>(
  handler: (args: Args, extra: Extra) => Promise<CallToolResult>,
): (args: Args, extra: Extra) => Promise<CallToolResult> {
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (err) {
      return toErrorResult(err);
    }
  };
}

/** Body fields shared by all three report types. */
export function commonBodyFields(args: {
  start_date: string;
  end_date?: string;
  project_ids?: (number | null)[];
  client_ids?: (number | null)[];
  tag_ids?: (number | null)[];
  user_ids?: number[];
  billable?: boolean;
  description?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { start_date: args.start_date };
  if (args.end_date !== undefined) body.end_date = args.end_date;
  if (args.project_ids !== undefined) body.project_ids = args.project_ids;
  if (args.client_ids !== undefined) body.client_ids = args.client_ids;
  if (args.tag_ids !== undefined) body.tag_ids = args.tag_ids;
  if (args.user_ids !== undefined) body.user_ids = args.user_ids;
  if (args.billable !== undefined) body.billable = args.billable;
  if (args.description !== undefined) body.description = args.description;
  return body;
}
