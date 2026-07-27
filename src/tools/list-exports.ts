import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { listExportFiles } from '../exports.js';
import { withErrorHandling, type ToolContext } from './common.js';

export function registerListExportsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'toggl_list_report_exports',
    {
      title: 'List previously exported Toggl report files',
      description:
        'Lists PDF/CSV report files in the configured export directory (TOGGL_EXPORT_DIR), ' +
        'newest first. Use this to find previously generated exports.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe('Maximum number of files to return. Defaults to 50.'),
      },
      outputSchema: {
        export_dir: z.string(),
        files: z.array(
          z.object({
            filename: z.string(),
            file_path: z.string(),
            file_size_bytes: z.number(),
            modified_at: z.string(),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withErrorHandling(async (args) => {
      const files = await listExportFiles(ctx.exportDir, args.limit ?? 50);
      const structured = { export_dir: ctx.exportDir, files };
      return {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    }),
  );
}
