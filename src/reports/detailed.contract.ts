/** MCP tools for the detailed report family: paged entry search, totals and file export. */

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

/** Sort fields the detailed report accepts. */
const DetailedOrderBy = z.enum(['date', 'user', 'duration', 'description', 'last_update']);

/** Options shared by the detailed search and export endpoints. */
const detailedOptionsShape = {
  order_by: DetailedOrderBy.optional().describe('Sort field, default date'),
  order_dir: OrderDir.optional().describe('Sort direction'),
  grouped: z.boolean().optional().describe('Group time entries, default false'),
  hide_amounts: z.boolean().optional().describe('Hide monetary amounts, default false'),
  enrich_response: z
    .boolean()
    .optional()
    .describe('Return as much information per entry as the export does, default false'),
  page_size: z.number().int().positive().optional().describe('Entries per page, default 50'),
  first_id: z
    .number()
    .int()
    .optional()
    .describe('Pagination cursor: pass the next_id value returned by the previous page'),
  first_row_number: z
    .number()
    .int()
    .optional()
    .describe('Pagination cursor: pass the next_row_number value returned by the previous page'),
  first_timestamp: z.number().int().optional().describe('Pagination cursor by timestamp'),
};

/** Export options Toggl only accepts on the PDF variant of the detailed endpoint. */
const DETAILED_PDF_ONLY = ['cents_separator', 'date_format', 'display_mode', 'hour_format'];

/** Registers the three detailed-report tools on the server. */
export function registerDetailedTools(context: ReportToolContext): void {
  const { server, client, workspaces } = context;

  // Paged JSON search over individual time entries.
  server.registerTool(
    'search_detailed_time_entries',
    {
      title: 'Search detailed time entries',
      description:
        'Returns time entries for a detailed report as JSON according to the given filters. Paginated: when next_id / next_row_number are present in the result, pass them as first_id / first_row_number to fetch the next page. At least one filter must be set.',
      inputSchema: {
        workspace_id: WorkspaceIdInput,
        ...sharedFilterShape,
        ...detailedOptionsShape,
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
          action: 'the detailed report',
          call,
        });
        const result = await fetchWorkspaceJson({
          context,
          path: `/workspace/${workspaceId}/search/time_entries`,
          body,
          call,
        });
        return toStructuredResult({
          data: result.body,
          next_id: result.nextId,
          next_row_number: result.nextRowNumber,
        });
      }),
  );

  // Aggregated totals for the same filter set.
  server.registerTool(
    'get_detailed_totals',
    {
      title: 'Get detailed report totals',
      description:
        'Returns total sums (seconds, amounts, optional graph) for a detailed report according to the given filters. At least one filter must be set.',
      inputSchema: {
        workspace_id: WorkspaceIdInput,
        ...sharedFilterShape,
        grouped: z.boolean().optional().describe('Group time entries, default false'),
        granularity: Resolution.optional().describe(
          'Totals granularity; overrides the resolution value',
        ),
        resolution: Resolution.optional().describe('Graph resolution'),
        with_graph: z.boolean().optional().describe('Include graph data, default false'),
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
          action: 'the detailed report totals',
          call,
        });
        const result = await fetchWorkspaceJson({
          context,
          path: `/workspace/${workspaceId}/search/time_entries/totals`,
          body,
          call,
        });
        return toStructuredResult({ data: result.body });
      }),
  );

  // File export into the local export directory.
  server.registerTool(
    'export_detailed_report',
    {
      title: 'Export detailed report',
      description:
        'Downloads a detailed report as pdf, csv or xlsx and writes it into the local export directory; returns the file path, size and a resource link instead of the report data. At least one filter must be set.',
      inputSchema: {
        workspace_id: WorkspaceIdInput,
        format: ExportFormat.describe('File format of the export'),
        filename: FilenameInput,
        ...sharedFilterShape,
        ...detailedOptionsShape,
        duration_format: DurationFormat.optional().describe('Duration rendering, default classic'),
        date_format: DateFormat.optional().describe('Date rendering (pdf only)'),
        display_mode: z.string().optional().describe('Display mode (pdf only)'),
        hour_format: z.string().optional().describe('Hour rendering (pdf only)'),
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
          action: 'the detailed report export',
          call,
        });
        return await runExport({
          context,
          call,
          path: `/workspace/${workspaceId}/search/time_entries.${format}`,
          body: buildExportBody(fields, DETAILED_PDF_ONLY, format),
          format,
          reportType: 'detailed',
          workspaceId,
          filename,
          defaultBaseName: buildExportBaseName(
            'detailed',
            workspaceId,
            args.start_date,
            args.end_date,
          ),
          dateRange: args,
        });
      }),
  );
}
