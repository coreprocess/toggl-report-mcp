# toggl-report-mcp

> Turn "send me July as a PDF" into a file on disk. An MCP server for the full
> [Toggl Reports API v3](https://engineering.toggl.com/docs/reports_start/), served over stdio.

It exposes the whole report surface: detailed, summary, weekly and saved reports. Report data
comes back as structured JSON. Exports (PDF, CSV or XLSX) are downloaded into a local directory,
and the tool returns the file path.

It is built to **complement
[verygoodplugins/mcp-toggl](https://github.com/verygoodplugins/mcp-toggl)**. That server covers
live Toggl data: timers, time entries and lookups. This one covers the official reports and
their **file exports**. You can run both side by side: they share env var names and the error
payload shape, and no tool names collide.

## Tools

| Tool | What it does |
| --- | --- |
| `search_detailed_time_entries` | Detailed report entries, paginated via `next_id` / `next_row_number` |
| `get_detailed_totals` | Total sums (and optional graph) for a detailed report |
| `export_detailed_report` | Detailed report as a `pdf`, `csv` or `xlsx` file |
| `get_summary_report` | Grouped summaries (projects, clients, users, ...) |
| `export_summary_report` | Summary report as a `pdf`, `csv` or `xlsx` file |
| `list_project_user_summaries` | Tracked/billable seconds per project-user pair |
| `get_project_summary` | Seconds, amounts, rates and graph for one project |
| `get_weekly_report` | Time entries grouped per day of the week |
| `export_weekly_report` | Weekly report as a `csv` or `pdf` file |
| `load_saved_report` | A saved (shared) report by its share token |
| `export_saved_report` | Saved report as a `pdf`, `csv` or `xlsx` file |
| `list_report_exports` | Previously exported files in the export directory, newest first |

Export tools return:

- the absolute file path;
- the size;
- the report type, workspace and requested date range;
- a `row_count` for CSV exports, so an empty result is visible instead of silently handing over an
  empty file;
- a `resource_link` to the file.

An optional `filename` argument chooses the base name. Otherwise the name is derived from the
report and a timestamp. Existing files are never overwritten; a name collision gets a numeric
suffix instead.

Example prompts:

```text
Export July as a detailed CSV report.
Give me a PDF summary of the Acme project for Q2, grouped by user.
Export last week's weekly report as a PDF.
Which reports have I already exported?
```

## Configuration

Everything is configured through environment variables, usually set in the `env` block of your
MCP client config. A `.env` file is **not** read. [.env.example](.env.example) lists them all
for reference.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `TOGGL_API_KEY` | yes | – | Toggl API token ([track.toggl.com/profile](https://track.toggl.com/profile)). `TOGGL_API_TOKEN` and `TOGGL_TOKEN` are accepted as aliases (the same names as mcp-toggl). Without a token, the server starts, but tools return `CONFIG_ERROR`. |
| `TOGGL_EXPORT_DIR` | yes | – | **Absolute** path of the export directory (`TOGGL_REPORT_MCP_DIR` is accepted as an alias). The server creates it with mode `0700` at startup if it is missing. Relative paths are rejected because MCP clients start servers from an unpredictable working directory. |
| `TOGGL_DEFAULT_WORKSPACE_ID` | no | – | Used when a tool call omits `workspace_id`. |
| `TOGGL_API_BASE_URL` | no | `https://api.track.toggl.com` | Override for testing. Must be HTTPS unless it points at a loopback address. |
| `TOGGL_REQUEST_TIMEOUT_MS` | no | `60000` | HTTP timeout per attempt. Large exports can be slow. |
| `TOGGL_MAX_EXPORT_MB` | no | `100` | Hard cap on a downloaded response. Larger responses fail with `RESPONSE_TOO_LARGE` instead of exhausting memory. |

### Workspace resolution

Workspace-scoped tools resolve the workspace in this order:

1. The `workspace_id` tool argument.
2. `TOGGL_DEFAULT_WORKSPACE_ID`.
3. Auto-detection. If the token can access exactly **one** workspace, that workspace is used.
   With **several**, the tool returns a `WORKSPACE_REQUIRED` error that lists them (`id` and
   `name`), so the client can retry with an explicit `workspace_id`.

The workspace list is cached in-process for one hour.

## Behavior notes

- **Plan gating.** Some exports, such as CSV or XLSX of detailed reports and saved reports,
  require a paid Toggl plan. On other plans, the tool returns `FEATURE_UNAVAILABLE` and names the
  feature.
- **Rate limits.** All requests pass through a single queue (about 1 request per second).
  - `429`, `5xx` and network errors are retried briefly.
  - A long `Retry-After` surfaces as `RATE_LIMITED`.
  - The hourly quota (`402` with `X-Toggl-Quota-*` headers) surfaces as `TOGGL_QUOTA_EXCEEDED`,
    with the reset time.
- **Auth errors.** Toggl uses `403` for failed authentication, so both `401` and `403` are
  reported as `AUTH_FAILED`. When possible, the error lists the workspaces the token can access.
- **Response validation.** Downloaded files are checked against their format signature (PDF, XLSX
  zip, plain CSV), so an error page is never saved as a report.
- **File safety.**
  - Filenames are sanitized: no path traversal, control characters or Windows reserved names.
  - Writes are atomic (a temp file plus a link) and files get mode `0600`.
  - Temp files left by a crashed run are cleaned up at startup.
- **Error payloads.** Tool errors set `isError` and carry a flat JSON payload, such as
  `{ "error": true, "code": "...", "message": "..." }`. The codes are `AUTH_FAILED`,
  `CANCELLED`, `CONFIG_ERROR`, `FEATURE_UNAVAILABLE`, `FILE_WRITE_ERROR`, `INVALID_FILENAME`,
  `INVALID_REQUEST`, `INVALID_RESPONSE`, `NETWORK_ERROR`, `NOT_FOUND`, `RATE_LIMITED`,
  `RESPONSE_TOO_LARGE`, `TIMEOUT`, `TOGGL_QUOTA_EXCEEDED`, `UPSTREAM_ERROR` and
  `WORKSPACE_REQUIRED`.
- **Logs.** Diagnostics go to stderr only, because stdout carries the MCP protocol.

## Getting started

Requires Node ≥ 24. Register the published package with your MCP client (stdio):

```json
{
  "mcpServers": {
    "toggl-report": {
      "command": "npx",
      "args": ["-y", "toggl-report-mcp"],
      "env": {
        "TOGGL_API_KEY": "<your api token>",
        "TOGGL_EXPORT_DIR": "/absolute/path/to/exports",
        "TOGGL_DEFAULT_WORKSPACE_ID": "1234567"
      }
    }
  }
}
```

To run from a checkout instead, build with `pnpm install && pnpm build` and use
`"command": "node", "args": ["/path/to/toggl-report-mcp/dist/main.js"]`.

For interactive testing: `npx @modelcontextprotocol/inspector node dist/main.js`.

## Checks

All of these must pass before a change is done (CI runs them too):

```bash
pnpm typecheck
pnpm lint         # or `pnpm fix` to auto-format (Biome)
pnpm test         # Vitest
pnpm knip         # dead-code check
pnpm build
```

## Conventions

Coding standards live in [.cursor/rules/coding-standards.mdc](.cursor/rules/coding-standards.mdc);
branch, commit and release conventions are defined in [PROJECT.md](PROJECT.md).

## License

[MIT](LICENSE).
