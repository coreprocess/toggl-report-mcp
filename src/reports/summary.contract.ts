/**
 * MCP tools for the summary report family: grouped summary data, per-project summaries,
 * project-user summaries and file export.
 */

import { z } from 'zod';
import {
  buildExportBaseName,
  buildExportBody,
  DateFormat,
  DurationFormat,
  ExportFormat,
  FilenameInput,
  OrderDir,
  type ReportToolContext,
  Resolution,
  sharedFilterShape,
  WorkspaceIdInput,
} from './filters.contract.ts';
import {
  assertDateOrder,
  EXPORT_ANNOTATIONS,
  exportOutputShape,
  fetchWorkspaceJson,
  READ_ANNOTATIONS,
  runExport,
  runTool,
  toStructuredResult,
} from './results.ts';

/** Sort fields the summary report accepts. */
const SummaryOrderBy = z.enum(['title', 'duration']);

/** Time Audit options (premium feature) accepted by summary endpoints. */
const AuditInput = z
  .object({
    group_filter: z
      .object({
        currency: z.string().optional().describe('Audit currency, example USD'),
        min_amount_cents: z.number().int().optional().describe('Minimum amount in cents'),
        max_amount_cents: z.number().int().optional().describe('Maximum amount in cents'),
        min_duration_seconds: z.number().int().optional().describe('Minimum duration in seconds'),
        max_duration_seconds: z.number().int().optional().describe('Maximum duration in seconds'),
      })
      .optional()
      .describe('Filter groups by amount or duration'),
    show_empty_groups: z.boolean().optional().describe('Display empty groups, default false'),
    show_tracked_groups: z.boolean().optional().describe('Display tracked groups, default true'),
  })
  .optional()
  .describe('Time Audit options (premium feature)');

/** Options shared by the summary JSON and export endpoints. */
const summaryOptionsShape = {
  grouping: z
    .string()
    .optional()
    .describe('Primary grouping, e.g. projects, clients, users, tags, tasks'),
  sub_grouping: z
    .string()
    .optional()
    .describe('Secondary grouping inside each primary group, e.g. time_entries, tasks, users'),
  distinguish_rates: z
    .boolean()
    .optional()
    .describe('Create a subgroup per billable rate, default false'),
  include_time_entry_ids: z
    .boolean()
    .optional()
    .describe('Include time entry IDs in the results, default false; not applicable for export'),
  audit: AuditInput,
};

/** Export options Toggl only accepts on the PDF variant of the summary endpoint. */
const SUMMARY_PDF_ONLY = ['cents_separator', 'date_format', 'resolution'];

/** Registers the four summary-report tools on the server. */
export function registerSummaryTools(context: ReportToolContext): void {
  const { server, client, workspaces } = context;

  // Grouped summary data as JSON.
  server.registerTool(
    'get_summary_report',
    {
      title: 'Get summary report',
      description:
        'Returns grouped time entry summaries (per project, client, user, ...) as JSON according to the given filters. At least one filter must be set.',
      inputSchema: {
        workspace_id: WorkspaceIdInput,
        ...sharedFilterShape,
        ...summaryOptionsShape,
      },
      annotations: READ_ANNOTATIONS,
    },
    (args, extra) =>
      runTool(async () => {
        const { workspace_id, ...body } = args;
        assertDateOrder(args);
        const call = client.createCallContext(extra.signal);
        const workspaceId = await workspaces.resolve({
          provided: workspace_id,
          action: 'the summary report',
          call,
        });
        const result = await fetchWorkspaceJson({
          context,
          path: `/workspace/${workspaceId}/summary/time_entries`,
          body,
          call,
        });
        return toStructuredResult({ data: result.body });
      }),
  );

  // File export into the local export directory.
  server.registerTool(
    'export_summary_report',
    {
      title: 'Export summary report',
      description:
        'Downloads a summary report as pdf, csv or xlsx and writes it into the local export directory; returns the file path, size and a resource link instead of the report data. At least one filter must be set.',
      inputSchema: {
        workspace_id: WorkspaceIdInput,
        format: ExportFormat.describe('File format of the export'),
        filename: FilenameInput,
        ...sharedFilterShape,
        ...summaryOptionsShape,
        collapse: z.boolean().optional().describe('Collapse the "others" group, default false'),
        duration_format: DurationFormat.optional().describe('Duration rendering, default classic'),
        hide_amounts: z.boolean().optional().describe('Hide monetary amounts, default false'),
        hide_rates: z.boolean().optional().describe('Hide billable rates, default false'),
        order_by: SummaryOrderBy.optional().describe('Sort field, default title'),
        order_dir: OrderDir.optional().describe('Sort direction'),
        date_format: DateFormat.optional().describe('Date rendering (pdf only)'),
        resolution: Resolution.optional().describe('Graph resolution (pdf only)'),
        cents_separator: z.string().optional().describe('Cents separator character (pdf only)'),
      },
      outputSchema: exportOutputShape,
      annotations: EXPORT_ANNOTATIONS,
    },
    (args, extra) =>
      runTool(async () => {
        const { workspace_id, format, filename, ...fields } = args;
        assertDateOrder(args);
        const call = client.createCallContext(extra.signal);
        const workspaceId = await workspaces.resolve({
          provided: workspace_id,
          action: 'the summary report export',
          call,
        });
        return await runExport({
          context,
          call,
          path: `/workspace/${workspaceId}/summary/time_entries.${format}`,
          body: buildExportBody(fields, SUMMARY_PDF_ONLY, format),
          format,
          reportType: 'summary',
          workspaceId,
          filename,
          defaultBaseName: buildExportBaseName(
            'summary',
            workspaceId,
            args.start_date,
            args.end_date,
          ),
          dateRange: args,
        });
      }),
  );

  // Tracked and billable seconds per project-user pair.
  server.registerTool(
    'list_project_user_summaries',
    {
      title: 'List project user summaries',
      description:
        'Returns tracked and billable seconds per project-user pair in the workspace for the given date range.',
      inputSchema: {
        workspace_id: WorkspaceIdInput,
        start_date: sharedFilterShape.start_date,
        end_date: sharedFilterShape.end_date,
      },
      annotations: READ_ANNOTATIONS,
    },
    (args, extra) =>
      runTool(async () => {
        const { workspace_id, ...body } = args;
        assertDateOrder(args);
        const call = client.createCallContext(extra.signal);
        const workspaceId = await workspaces.resolve({
          provided: workspace_id,
          action: 'the project user summaries',
          call,
        });
        const result = await fetchWorkspaceJson({
          context,
          path: `/workspace/${workspaceId}/projects/summary`,
          body,
          call,
        });
        return toStructuredResult({ data: result.body });
      }),
  );

  // Single project summary: seconds, amounts, rates, graph.
  server.registerTool(
    'get_project_summary',
    {
      title: 'Get project summary',
      description:
        'Returns the summary of one project for the given date range: tracked seconds, billable amounts, rates and graph data.',
      inputSchema: {
        workspace_id: WorkspaceIdInput,
        project_id: z.number().int().positive().describe('Numeric project ID'),
        start_date: sharedFilterShape.start_date,
        end_date: sharedFilterShape.end_date,
      },
      annotations: READ_ANNOTATIONS,
    },
    (args, extra) =>
      runTool(async () => {
        const { workspace_id, project_id, ...body } = args;
        assertDateOrder(args);
        const call = client.createCallContext(extra.signal);
        const workspaceId = await workspaces.resolve({
          provided: workspace_id,
          action: 'the project summary',
          call,
        });
        const result = await fetchWorkspaceJson({
          context,
          path: `/workspace/${workspaceId}/projects/${project_id}/summary`,
          body,
          call,
        });
        return toStructuredResult({ data: result.body });
      }),
  );
}
