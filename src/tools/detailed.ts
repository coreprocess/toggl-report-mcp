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

export function registerDetailedExportTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'toggl_export_detailed_report',
    {
      title: 'Export detailed Toggl report (PDF/CSV file)',
      description:
        `${FILE_TOOL_DISCLAIMER} Exports the Toggl detailed report (one row per time entry) ` +
        'for a workspace and date range via the Toggl Reports API v3. ' +
        'Note: CSV export of the detailed report requires a paid Toggl plan; PDF works on all plans.',
      inputSchema: {
        ...commonExportInputs,
        start_date: dateSchema.describe('Start of the reporting period. ISO date, YYYY-MM-DD.'),
        end_date: dateSchema.describe('End of the reporting period (inclusive). ISO date, YYYY-MM-DD.'),
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
      if (args.duration_format !== undefined) body.duration_format = args.duration_format;
      if (args.hide_amounts !== undefined) body.hide_amounts = args.hide_amounts;
      return runExport(ctx, {
        reportType: 'detailed',
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
