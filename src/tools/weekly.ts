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

export function registerWeeklyExportTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'toggl_export_weekly_report',
    {
      title: 'Export weekly Toggl report (PDF/CSV file)',
      description:
        `${FILE_TOOL_DISCLAIMER} Exports the Toggl weekly report (a 7-day grid starting at ` +
        'start_date) for a workspace via the Toggl Reports API v3.',
      inputSchema: {
        ...commonExportInputs,
        start_date: dateSchema.describe('First day of the reported week. ISO date, YYYY-MM-DD.'),
        end_date: dateSchema
          .optional()
          .describe('Optional end date; the API defaults to one week from start_date.'),
        calculate: z
          .enum(['time', 'amounts'])
          .optional()
          .describe('Whether the grid shows tracked time or monetary amounts.'),
        group_by_task: z.boolean().optional().describe('Group entries by task.'),
      },
      outputSchema: exportOutputShape,
      annotations: exportAnnotations,
    },
    withErrorHandling(async (args, extra) => {
      assertDateOrder(args.start_date, args.end_date);
      const body = commonBodyFields(args);
      if (args.calculate !== undefined) body.calculate = args.calculate;
      if (args.group_by_task !== undefined) body.group_by_task = args.group_by_task;
      return runExport(ctx, {
        reportType: 'weekly',
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
