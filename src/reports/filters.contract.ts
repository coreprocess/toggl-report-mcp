/**
 * Shared building blocks for the Reports API v3 tools: the wiring context handed to every
 * registration function, the filter schemas and enums common to all report families, and
 * the helpers shaping export request bodies and filenames.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExportStore } from '#store/store';
import type { TogglClient } from '#toggl/client';
import type { WorkspaceResolver } from '#toggl/workspaces';

/** Wiring bag handed to every tool-registration function by the composition root. */
export interface ReportToolContext {
  /** MCP server the tools register on. */
  server: McpServer;
  /** Client performing the Toggl API calls. */
  client: TogglClient;
  /** Store receiving exported report files. */
  store: ExportStore;
  /** Picks the workspace for each call: argument, configured default, or sole workspace. */
  workspaces: WorkspaceResolver;
}

/** File formats a report can be exported to. */
export const ExportFormat = z.enum(['pdf', 'csv', 'xlsx']);
export type ExportFormat = z.infer<typeof ExportFormat>;

/** Date rendering options accepted by PDF exports. */
export const DateFormat = z.enum([
  'MM/DD/YYYY',
  'DD-MM-YYYY',
  'MM-DD-YYYY',
  'YYYY-MM-DD',
  'DD/MM/YYYY',
  'DD.MM.YYYY',
]);

/** Duration rendering options accepted by exports. */
export const DurationFormat = z.enum(['classic', 'decimal', 'improved']);

/** Sort direction accepted by the API. */
export const OrderDir = z.enum(['ASC', 'DESC']);

/** Resolution steps for graphs and totals. */
export const Resolution = z.enum(['day', 'week', 'month']);

/** Builds an entity-ID filter schema; a null entry selects records without that entity. */
function buildIdsFilter(description: string) {
  return z.array(z.number().int().nullable()).optional().describe(description);
}

/** Calendar date in YYYY-MM-DD form; impossible dates such as 2025-02-30 are rejected. */
const DateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format')
  .refine(
    (value) => {
      const date = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
    },
    { message: 'Expected an existing calendar date' },
  );

/** Filter fields accepted by every report family; spread into each tool's input schema. */
export const sharedFilterShape = {
  start_date: DateInput.optional().describe('Start date, format YYYY-MM-DD (inclusive)'),
  end_date: DateInput.optional().describe(
    'End date, format YYYY-MM-DD (inclusive); must not be before start_date',
  ),
  billable: z.boolean().optional().describe('Filter by billable state (premium feature)'),
  description: z.string().optional().describe('Filter by time entry description'),
  client_ids: buildIdsFilter('Client IDs to filter by; use [null] for entries without a client'),
  project_ids: buildIdsFilter('Project IDs to filter by; use [null] for entries without a project'),
  tag_ids: buildIdsFilter('Tag IDs to filter by; use [null] for entries without tags'),
  task_ids: buildIdsFilter('Task IDs to filter by; use [null] for entries without a task'),
  group_ids: z.array(z.number().int()).optional().describe('User group IDs to filter by'),
  user_ids: z.array(z.number().int()).optional().describe('User IDs to filter by'),
  time_entry_ids: z
    .array(z.number().int())
    .optional()
    .describe('Specific time entry IDs to filter by'),
  min_duration_seconds: z
    .number()
    .int()
    .optional()
    .describe('Minimum entry duration in seconds (Time Audit); must be below max_duration_seconds'),
  max_duration_seconds: z
    .number()
    .int()
    .optional()
    .describe('Maximum entry duration in seconds (Time Audit); must be above min_duration_seconds'),
  rounding: z
    .number()
    .int()
    .optional()
    .describe('1 to round durations, 0 to keep them exact; default from user preferences'),
  rounding_minutes: z
    .literal([0, 1, 5, 6, 10, 12, 15, 30, 60, 240])
    .optional()
    .describe('Rounding granularity in minutes'),
};

/** Workspace ID input; optional because a default or a sole account workspace can fill it in. */
export const WorkspaceIdInput = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    'Numeric Toggl workspace ID; may be omitted when the server has a configured default (TOGGL_DEFAULT_WORKSPACE_ID) or the account has exactly one workspace. When omitted and ambiguous, the error lists the available workspace IDs to retry with.',
  );

/** Optional caller-chosen export filename. */
export const FilenameInput = z
  .string()
  .max(255)
  .optional()
  .describe(
    'Optional output filename (basename only, no directories). The correct extension is enforced. Existing files are never overwritten; a numeric suffix is appended on collision.',
  );

/** Builds an export request body, dropping PDF-only options when the format is not pdf. */
export function buildExportBody(
  fields: Record<string, unknown>,
  pdfOnlyKeys: readonly string[],
  format: ExportFormat,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...fields };
  if (format !== 'pdf') {
    for (const key of pdfOnlyKeys) {
      delete body[key];
    }
  }
  return body;
}

/** Builds the descriptive part of an export filename: family, scope and date range. */
export function buildExportBaseName(
  family: string,
  scope: string | number,
  startDate: string | undefined,
  endDate: string | undefined,
): string {
  return `${family}-${scope}-${startDate ?? 'all'}-${endDate ?? 'all'}`;
}
