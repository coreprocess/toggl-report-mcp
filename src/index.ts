#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ConfigError, loadConfig } from './config.js';
import { TogglClient } from './toggl-client.js';
import type { ToolContext } from './tools/common.js';
import { registerDetailedExportTool } from './tools/detailed.js';
import { registerListExportsTool } from './tools/list-exports.js';
import { registerSummaryExportTool } from './tools/summary.js';
import { registerWeeklyExportTool } from './tools/weekly.js';

const SERVER_NAME = 'toggl-report-mcp';
const SERVER_VERSION = '0.1.0';

// stdout is reserved for the MCP protocol; all diagnostics go to stderr.
// dotenv >= 17 prints an injection banner to stdout unless quiet is set,
// which would corrupt the JSON-RPC stream.
loadDotenv({ quiet: true });

function log(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      log(`Fatal configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (!config.apiToken) {
    // Deliberately not fatal: tools surface CONFIG_ERROR in-chat, which the
    // user actually sees, unlike a "server disconnected" client message.
    log(
      'Warning: no Toggl API token configured (TOGGL_API_KEY / TOGGL_API_TOKEN / TOGGL_TOKEN). ' +
        'Tools will return CONFIG_ERROR until one is set.',
    );
  }

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const ctx: ToolContext = {
    client: new TogglClient(config),
    exportDir: config.exportDir,
  };

  registerDetailedExportTool(server, ctx);
  registerSummaryExportTool(server, ctx);
  registerWeeklyExportTool(server, ctx);
  registerListExportsTool(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready (stdio transport); exports are written to ${config.exportDir}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
