/** MCP tools for the weekly report family: seven-day grouped data and file export. */

import { z } from 'zod';
import {
  buildExportBaseName,
  buildExportBody,
  DateFormat,
  DurationFormat,
  FilenameInput,
  type ReportToolContext,
  sharedFilterShape,
  WorkspaceIdInput,
} from './filters.contract.ts';
import {
  assertDateOrder,
  EXPORT_ANNOTATIONS,
  exportOutputSchema,
  fetchWorkspaceJson,
  READ_ANNOTATIONS,
  runExport,
  runTool,
  toStructuredResult,
} from './results.ts';

/** Formats the weekly export endpoint offers; xlsx is not available for weekly reports. */
const WeeklyExportFormat = z.enum(['csv', 'pdf']);

/** Export options Toggl only accepts on the PDF variant of the weekly endpoint. */
const WEEKLY_PDF_ONLY = ['cents_separator', 'date_format', 'duration_format', 'logo_url'];

/** Registers the two weekly-report tools on the server. */
export function registerWeeklyTools(context: ReportToolContext): void {
  const { server, client, workspaces } = context;

  // Weekly grouped data as JSON.
  server.registerTool(
    'get_weekly_report',
    {
      title: 'Get weekly report',
      description:
        'Returns time entries grouped per day of the week as JSON according to the given filters. At least one filter must be set.',
      inputSchema: {
        workspace_id: WorkspaceIdInput,
        ...sharedFilterShape,
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
          action: 'the weekly report',
          call,
        });
        const result = await fetchWorkspaceJson({
          context,
          path: `/workspace/${workspaceId}/weekly/time_entries`,
          body,
          call,
        });
        return toStructuredResult({ data: result.body });
      }),
  );

  // File export into the local export directory.
  server.registerTool(
    'export_weekly_report',
    {
      title: 'Export weekly report',
      description:
        'Downloads a weekly report as csv or pdf and writes it into the local export directory; returns the file path, size and a resource link instead of the report data. At least one filter must be set.',
      inputSchema: {
        workspace_id: WorkspaceIdInput,
        format: WeeklyExportFormat.describe('File format of the export'),
        filename: FilenameInput,
        ...sharedFilterShape,
        calculate: z
          .enum(['time', 'amounts'])
          .optional()
          .describe('Whether cells show tracked time or earned amounts'),
        group_by_task: z
          .boolean()
          .optional()
          .describe('Additionally group the data by planned task'),
        grouping: z.string().optional().describe('Grouping option, e.g. users, projects'),
        date_format: DateFormat.optional().describe('Date rendering (pdf only)'),
        duration_format: DurationFormat.optional().describe('Duration rendering (pdf only)'),
        logo_url: z.string().optional().describe('Logo shown on the report (pdf only)'),
        cents_separator: z.string().optional().describe('Cents separator character (pdf only)'),
      },
      outputSchema: exportOutputSchema,
      annotations: EXPORT_ANNOTATIONS,
    },
    (args, extra) =>
      runTool(async () => {
        const { workspace_id, format, filename, ...fields } = args;
        assertDateOrder(args);
        const call = client.createCallContext(extra.signal);
        const workspaceId = await workspaces.resolve({
          provided: workspace_id,
          action: 'the weekly report export',
          call,
        });
        return await runExport({
          context,
          call,
          path: `/workspace/${workspaceId}/weekly/time_entries.${format}`,
          body: buildExportBody(fields, WEEKLY_PDF_ONLY, format),
          format,
          reportType: 'weekly',
          workspaceId,
          filename,
          defaultBaseName: buildExportBaseName(
            'weekly',
            workspaceId,
            args.start_date,
            args.end_date,
          ),
          dateRange: args,
        });
      }),
  );
}
