/** MCP tool listing the report files already present in the local export directory. */

import { z } from 'zod';
import type { ReportToolContext } from './filters.contract.ts';
import { outputSchema, runTool, toStructuredResult } from './results.ts';

/** Registers the export listing tool on the server. */
export function registerFileTools(context: ReportToolContext): void {
  const { server, store } = context;

  // Local directory listing; no Toggl API call involved.
  server.registerTool(
    'list_report_exports',
    {
      title: 'List report exports',
      description:
        'Lists pdf, csv and xlsx files in the local export directory, newest first, with path, size and modification time. Does not call the Toggl API.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .default(50)
          .describe('Maximum number of files to return, default 50'),
      },
      outputSchema: outputSchema({
        export_dir: z.string().describe('Absolute export directory'),
        files: z
          .array(
            z.object({
              filename: z.string(),
              file_path: z.string(),
              file_size_bytes: z.number().int(),
              modified_at: z.string().describe('ISO timestamp of the last modification'),
            }),
          )
          .describe('Export files, newest first'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      runTool(async () =>
        toStructuredResult({ export_dir: store.dir, files: await store.list(args.limit) }),
      ),
  );
}
