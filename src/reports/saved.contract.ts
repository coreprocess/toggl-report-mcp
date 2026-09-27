/**
 * MCP tools for saved (shared) reports: loading a report by its share token and exporting
 * it with its stored parameters.
 */

import { z } from 'zod';
import { ExportFormat, FilenameInput, type ReportToolContext } from './filters.contract.ts';
import {
  EXPORT_ANNOTATIONS,
  exportOutputShape,
  READ_ANNOTATIONS,
  runExport,
  runTool,
  toStructuredResult,
} from './results.ts';

/** Share token of a previously saved report. */
const ReportTokenInput = z
  .string()
  .min(1)
  .describe('Share token of the saved report (from its share URL)');

/** Reduces a share token to filename-safe characters for the export filename. */
function sanitizeToken(token: string): string {
  return token.replaceAll(/[^\w-]/g, '_');
}

/** Registers the two saved-report tools on the server. */
export function registerSavedTools(context: ReportToolContext): void {
  const { server, client } = context;

  // Saved report data as JSON, executed with its stored parameters.
  server.registerTool(
    'load_saved_report',
    {
      title: 'Load saved report',
      description:
        'Loads a previously saved (shared) report by its share token, executed with the saved parameters. Private reports require the owner or a workspace admin.',
      inputSchema: {
        report_token: ReportTokenInput,
      },
      annotations: READ_ANNOTATIONS,
    },
    (args, extra) =>
      runTool(async () => {
        const result = await client.requestJson({
          path: `/shared/${encodeURIComponent(args.report_token)}`,
          body: {},
          call: client.createCallContext(extra.signal),
        });
        return toStructuredResult({ data: result.body });
      }),
  );

  // File export of the saved report into the local export directory.
  server.registerTool(
    'export_saved_report',
    {
      title: 'Export saved report',
      description:
        'Downloads a previously saved (shared) report as pdf, csv or xlsx with its saved parameters and writes it into the local export directory; returns the file path, size and a resource link instead of the report data.',
      inputSchema: {
        report_token: ReportTokenInput,
        format: ExportFormat.describe('File format of the export'),
        filename: FilenameInput,
      },
      outputSchema: exportOutputShape,
      annotations: EXPORT_ANNOTATIONS,
    },
    (args, extra) =>
      runTool(async () => {
        const { report_token, format, filename } = args;
        return await runExport({
          context,
          call: client.createCallContext(extra.signal),
          path: `/shared/${encodeURIComponent(report_token)}/${format}`,
          body: {},
          format,
          reportType: 'saved',
          workspaceId: null,
          filename,
          defaultBaseName: `saved-${sanitizeToken(report_token)}`,
          dateRange: { start_date: undefined, end_date: undefined },
        });
      }),
  );
}
