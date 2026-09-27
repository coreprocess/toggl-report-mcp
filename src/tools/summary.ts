import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  assertDateOrder,
  commonBodyFields,
  commonExportInputs,
  dateSchema,
  exportAnnotations,
  exportOutputShape,
  FILE_TOOL_DISCLAIMER,
  runExport,
  withErrorHandling,
  type ToolContext,
} from './common.js';

export function registerSummaryExportTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'toggl_export_summary_report',
    {
      title: 'Export summary Toggl report (PDF/CSV file)',
      description:
        `${FILE_TOOL_DISCLAIMER} Exports the Toggl summary report (totals grouped by project, ` +
        'client, or user) for a workspace and date range via the Toggl Reports API v3.',
      inputSchema: {
        ...commonExportInputs,
        start_date: dateSchema.describe('Start of the reporting period. ISO date, YYYY-MM-DD.'),
        end_date: dateSchema.describe('End of the reporting period (inclusive). ISO date, YYYY-MM-DD.'),
        grouping: z
          .enum(['projects', 'clients', 'users'])
          .optional()
          .describe('Primary grouping. Defaults to "projects".'),
        sub_grouping: z
          .enum(['time_entries', 'tasks', 'projects', 'clients', 'users'])
          .optional()
          .describe('Secondary grouping. Defaults to "time_entries".'),
        duration_format: z
          .enum(['classic', 'decimal', 'improved'])
          .optional()
          .describe('Duration format. "decimal" is usually best for spreadsheets/invoicing.'),
        hide_amounts: z.boolean().optional().describe('Hide monetary amounts in the export.'),
      },
      outputSchema: exportOutputShape,
      annotations: exportAnnotations,
    },
    withErrorHandling(async (args, extra) => {
      assertDateOrder(args.start_date, args.end_date);
      const body = commonBodyFields(args);
      if (args.grouping !== undefined) body.grouping = args.grouping;
      if (args.sub_grouping !== undefined) body.sub_grouping = args.sub_grouping;
      if (args.duration_format !== undefined) body.duration_format = args.duration_format;
      if (args.hide_amounts !== undefined) body.hide_amounts = args.hide_amounts;
      return runExport(ctx, {
        reportType: 'summary',
        format: args.format,
        workspaceId: args.workspace_id,
        startDate: args.start_date,
        endDate: args.end_date,
        filename: args.filename,
        body,
        signal: extra.signal,
      });
    }),
  );
}
