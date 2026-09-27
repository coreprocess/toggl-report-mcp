#!/usr/bin/env node
/**
 * Composition root of the Toggl Reports MCP server: resolves configuration from the
 * environment, wires the API client, export store and tools together, and serves the
 * MCP protocol over stdio. All diagnostics go to stderr — stdout is the protocol channel.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type Config, ConfigError, parseConfig } from '#config/config';
import { registerDetailedTools } from '#reports/detailed';
import { registerFileTools } from '#reports/files';
import type { ReportToolContext } from '#reports/filters';
import { registerSavedTools } from '#reports/saved';
import { registerSummaryTools } from '#reports/summary';
import { registerWeeklyTools } from '#reports/weekly';
import { ExportStore } from '#store/store';
import { TogglClient } from '#toggl/client';
import { WorkspaceResolver } from '#toggl/workspaces';

/** Writes a diagnostic line to stderr; stdout carries the MCP protocol. */
function log(message: string): void {
  console.error(`[toggl-report-mcp] ${message}`);
}

// Resolve configuration first so a misconfigured server fails fast with a clear message.
let config: Config;
try {
  config = parseConfig(process.env);
} catch (err) {
  if (!(err instanceof ConfigError)) {
    throw err;
  }
  log(err.message);
  process.exit(1);
}
if (config.apiToken === undefined) {
  log(
    'Warning: no Toggl API token configured (TOGGL_API_KEY / TOGGL_API_TOKEN / TOGGL_TOKEN). Tools will return CONFIG_ERROR until one is set.',
  );
}

// Wire the shared collaborators; ~1 request/second matches Toggl's rate limit.
const server = new McpServer({ name: 'toggl-report-mcp', version: '0.1.0' });
const client = new TogglClient({
  apiToken: config.apiToken,
  baseUrl: config.apiBaseUrl,
  requestTimeoutMs: config.requestTimeoutMs,
  maxResponseBytes: config.maxResponseBytes,
  minRequestIntervalMs: 1000,
  fetchImpl: fetch,
});
const store = new ExportStore(config.exportDir);
const context: ReportToolContext = {
  server,
  client,
  store,
  workspaces: new WorkspaceResolver({ client, defaultWorkspaceId: config.defaultWorkspaceId }),
};

// Register the full Reports API v3 tool surface plus the export listing.
registerDetailedTools(context);
registerSummaryTools(context);
registerWeeklyTools(context);
registerSavedTools(context);
registerFileTools(context);

// Remove temp files a crashed earlier run may have left; failure only costs disk space.
store.cleanStaleTempFiles().catch((err: unknown) => {
  if (!(err instanceof Error && 'code' in err)) {
    throw err;
  }
  log(`Warning: could not clean stale temp files: ${err.message}`);
});

// Close the transport cleanly when the host stops the server.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}

// Serve MCP over stdio.
await server.connect(new StdioServerTransport());
log(`ready (stdio transport); exports are written to ${store.dir}`);
