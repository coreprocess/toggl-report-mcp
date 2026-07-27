# toggl-report-mcp

> Turn "send me July as a PDF" into a file on disk. An MCP server that creates
> **PDF** and **CSV** report exports via the official Toggl Reports API v3.

Designed as a **complement to
[verygoodplugins/mcp-toggl](https://github.com/verygoodplugins/mcp-toggl)**: that
server covers live Toggl data (timers, time entries, lookups, in-chat report
summaries); this one covers the missing piece — official report **file exports**
written to a local directory. Run both side by side; they share env var names and
tool-naming conventions, and there are no tool-name collisions.

## Tools

| Tool | What it does |
| --- | --- |
| `toggl_export_detailed_report` | Exports the detailed report (one row per time entry) as PDF or CSV. |
| `toggl_export_summary_report` | Exports the summary report (totals grouped by project/client/user) as PDF or CSV. |
| `toggl_export_weekly_report` | Exports the weekly report (7-day grid) as PDF or CSV. |
| `toggl_list_report_exports` | Lists previously exported files in the export directory, newest first. |

Export tools return the absolute file path, file size, and (for CSV) the data row
count, plus a `resource_link` to the file. Files are written atomically and never
overwritten — name collisions get a numeric suffix.

## Quick start

### Prerequisites

- Node.js `^20.19.0` or `>=22.12.0`
- A Toggl Track account and your API token from
  [track.toggl.com/profile](https://track.toggl.com/profile)

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "toggl-report-mcp": {
      "command": "npx",
      "args": ["-y", "toggl-report-mcp@latest"],
      "env": {
        "TOGGL_API_KEY": "your_api_token_here",
        "TOGGL_EXPORT_DIR": "/absolute/path/to/exports"
      }
    }
  }
}
```

Then ask things like:

```text
Export July as a detailed CSV report.
Give me a PDF summary of the Acme project for Q2, grouped by user.
Export last week's weekly report as a PDF.
Which reports have I already exported?
```

## Configuration

| Env var | Required | Default | Notes |
| --- | --- | --- | --- |
| `TOGGL_API_KEY` | Yes | – | Toggl API token. `TOGGL_API_TOKEN` and `TOGGL_TOKEN` are accepted as aliases (same names as mcp-toggl, so both servers can share one env block). |
| `TOGGL_EXPORT_DIR` | Yes | – | **Absolute** path of the directory exports are written to. Created on startup if missing. Relative paths are rejected because MCP clients start servers with an unpredictable working directory. |
| `TOGGL_DEFAULT_WORKSPACE_ID` | No | – | Used when a tool call omits `workspace_id`. |
| `TOGGL_API_BASE_URL` | No | `https://api.track.toggl.com` | Override for testing. Must be HTTPS unless pointing at a loopback address. |
| `TOGGL_REQUEST_TIMEOUT_MS` | No | `60000` | Per-attempt HTTP timeout. Large exports can be slow. |

A `.env` file in the working directory is loaded too (quietly — stdout is reserved
for the MCP protocol). See `.env.example`.

### Workspace resolution

Workspace-scoped tools resolve the workspace in this order:

1. The `workspace_id` tool argument, if provided.
2. `TOGGL_DEFAULT_WORKSPACE_ID`, if set.
3. Auto-detection: if the token can access exactly **one** workspace, it is used
   automatically. With **multiple** accessible workspaces the tool returns a
   `WORKSPACE_REQUIRED` error listing all available workspaces (`id` + `name`) so
   the calling model can retry with an explicit `workspace_id` — the same recovery
   flow as mcp-toggl.

The workspace list is cached in-process for one hour.

## Behavior notes

- **Plan gating**: CSV exports of the detailed report are a **paid-plan** Toggl
  feature. On Free plans the tool returns a `FEATURE_UNAVAILABLE` error naming the
  feature; PDF export may still work.
- **Rate limits**: all requests pass through a single queue (~1 request/second) to
  respect Toggl's leaky bucket. `429` responses are retried briefly; the hourly
  quota (`402` + `X-Toggl-Quota-*` headers, as low as 30 requests/hour on Free)
  surfaces as `TOGGL_QUOTA_EXCEEDED` with the reset time.
- **Auth errors**: Toggl returns HTTP `403` for failed authentication, so both
  `401` and `403` are reported as `AUTH_FAILED` covering bad tokens and missing
  workspace access. When possible, the error includes the accessible workspaces.
- **File safety**: filenames are sanitized (no path traversal, control characters,
  or Windows reserved names), writes are atomic (temp file + hard link), files get
  mode `0600`, and partial files are cleaned up on failure.
- **Empty results**: CSV results include `row_count`, so "no time entries matched"
  is visible instead of silently handing over an empty file.

### Where are the server logs?

Diagnostics go to stderr, never stdout. If the server fails to start, check your
client's MCP logs:

- **Claude Desktop** (macOS): `~/Library/Logs/Claude/mcp-server-toggl-report-mcp.log`
- **Cursor**: Output panel → "MCP Logs"

## Development

```bash
git clone https://github.com/coreprocess/toggl-report-mcp.git
cd toggl-report-mcp
npm install
npm run build
npm test
```

Useful commands:

```bash
npm run dev      # run from source with live reload (tsx)
npm run lint
npm run format
npx @modelcontextprotocol/inspector node dist/index.js   # interactive testing
```

The test suite includes a stdio smoke test that boots the real server against a
local HTTP stub (via `TOGGL_API_BASE_URL`) and asserts stdout carries nothing but
JSON-RPC.

## Roadmap

- Saved/shared report exports (`/reports/api/v3/shared/{token}/…`) — deferred:
  there is no API to discover a report token, and the feature is paid-plan only.
- XLSX export format.

See `PLAN.md` for the full design document.

## License

MIT.
