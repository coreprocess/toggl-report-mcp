# Plan: Toggl Report MCP Server (Node.js, stdio)

An MCP server that exposes the Toggl Reports API v3 export endpoints as MCP tools,
letting an MCP client (Cursor, Claude Desktop, etc.) create **PDF** and **CSV** report
exports and save them to a locally configured directory.

## Scope

- **In scope**
  - Node.js MCP server using the official `@modelcontextprotocol/sdk`.
  - **stdio transport only** (no HTTP/SSE transport for now).
  - Tools that create PDF and CSV exports via the Toggl Reports API v3.
  - Local state: an export directory configured via environment variable where all
    generated report files are written.
- **Out of scope (for now)**
  - Other transports (Streamable HTTP).
  - XLSX exports (the API supports them; easy to add later since the endpoints are
    format-parameterized).
  - Reading/analyzing report contents (JSON report endpoints), MCP resources/prompts.

## Toggl Reports API v3 background

Base URL: `https://api.track.toggl.com`. All export endpoints are `POST` with a JSON
filter body and HTTP Basic auth. The relevant endpoints:

| Report type | PDF | CSV |
| --- | --- | --- |
| Detailed | `/reports/api/v3/workspace/{workspace_id}/search/time_entries.pdf` | `.../search/time_entries.csv` |
| Summary | `/reports/api/v3/workspace/{workspace_id}/summary/time_entries.pdf` | `.../summary/time_entries.csv` |
| Weekly | `/reports/api/v3/workspace/{workspace_id}/weekly/time_entries.pdf` | `.../weekly/time_entries.csv` |
| Saved (shared) | `/reports/api/v3/shared/{report_token}/pdf` | `/reports/api/v3/shared/{report_token}/csv` |

Authentication: Toggl API token as Basic auth username with the literal string
`api_token` as the password (preferred over email/password so we never handle a real
password).

Rate limiting: Toggl enforces roughly 1 request/second per token and returns `429`;
the client must honor this.

## Configuration (environment variables)

| Variable | Required | Description |
| --- | --- | --- |
| `TOGGL_API_TOKEN` | yes | Toggl Track API token (from Profile settings). |
| `TOGGL_EXPORT_DIR` | yes | Absolute or relative directory where exported files are written. Created on startup if missing; startup fails with a clear error if not writable. |
| `TOGGL_WORKSPACE_ID` | no | Default workspace ID so tool calls can omit it. |
| `TOGGL_API_BASE_URL` | no | Override for testing/mocking. Defaults to `https://api.track.toggl.com`. |

Configuration is validated once at startup (fail fast with an actionable message on
stderr — never stdout, which is reserved for the MCP protocol).

## Workspace resolution

Workspace-scoped export tools (detailed, summary, weekly) resolve the workspace in
this order:

1. **`workspace_id` tool argument** — always wins if provided.
2. **`TOGGL_WORKSPACE_ID` env var** — used when the tool call omits the argument.
3. **Auto-detection** — if neither is set, the server calls the Toggl main API
   (`GET /api/v9/me/workspaces`, same host and auth as the Reports API) to list the
   workspaces accessible to the token:
   - **Exactly one workspace** → use it as the obvious default.
   - **Multiple workspaces** → return a tool error that enumerates all accessible
     workspaces as `id` + `name` pairs and instructs the model to retry with an
     explicit `workspace_id`. Example error text:
     `Multiple Toggl workspaces are accessible and no workspace_id was provided. Pass one of: 123456 "Acme Inc", 789012 "Personal".`
   - **Zero workspaces** → tool error explaining the token has no workspace access.

Implementation notes:

- Auto-detection lives in `toggl-client.ts` as `resolveWorkspaceId()` shared by all
  workspace-scoped tools.
- The workspace list is fetched lazily (first tool call that needs it, not at
  startup) and cached in memory for the process lifetime, so the multi-workspace
  error and subsequent retries don't burn extra requests against Toggl's rate limit.
- The tool descriptions document this behavior so the model knows `workspace_id` is
  optional and what the error means.
- Unit tests cover all four branches (explicit arg, env default, single-workspace
  auto-pick, multi-workspace error listing).

## Tool surface

One tool per report type, each taking a `format: "pdf" | "csv"` parameter. Separate
tools (rather than one mega-tool with a `report_type` discriminator) keep each input
schema small and accurate, which helps LLM tool selection.

1. **`export_detailed_report`**
   - Inputs: `format`, `start_date`, `end_date` (ISO `YYYY-MM-DD`), optional
     `workspace_id` (resolved per "Workspace resolution" above when omitted),
     optional filters (`project_ids`,
     `client_ids`, `tag_ids`, `user_ids`, `billable`, `description`, `grouped`,
     `order_by`/`order_dir`, `hide_amounts`, rounding options), optional `filename`.
2. **`export_summary_report`**
   - Same core inputs plus `grouping`, `sub_grouping`, `collapse`, `resolution`,
     `hide_rates`/`hide_amounts`.
3. **`export_weekly_report`**
   - Same core inputs plus `calculate` and `group_by_task`.
4. **`export_saved_report`**
   - Inputs: `report_token`, `format`, optional `filename`. Runs a saved/shared
     report with its stored parameters (no workspace ID needed).
5. **`list_report_exports`**
   - Lists files in the export directory (name, size, mtime) so the model can find
     previously generated exports. No inputs.

All export tools return a structured result: absolute file path, file size, format,
report type, and the date range used — so the client/user knows exactly where the
file landed.

Input schemas are defined with `zod` and registered via the SDK's
`server.registerTool(...)` API.

## File handling (the "local state")

- On startup: resolve `TOGGL_EXPORT_DIR` to an absolute path, `mkdir -p` it, and
  verify writability.
- Default filename pattern: `toggl-{report_type}-{start_date}_{end_date}-{yyyymmdd-hhmmss}.{ext}`
  (saved reports use the token prefix instead of dates).
- If the caller passes `filename`: sanitize it (strip path separators, reject `..`),
  force the correct extension, and resolve strictly inside the export directory to
  prevent path traversal. Never overwrite silently — append a numeric suffix on
  collision.
- PDF responses are written from the raw response bytes; CSV likewise (byte-for-byte,
  no re-encoding).

## HTTP client & error handling

Small internal client on top of Node's native `fetch` (Node ≥ 18):

- Basic auth header built from `TOGGL_API_TOKEN:api_token`.
- Timeouts via `AbortSignal.timeout` (exports can be slow for large ranges; ~60s).
- `429` handling: retry with backoff (honor `Retry-After` if present), max 3 attempts.
- Error mapping to MCP tool errors (`isError: true` with a human-readable message):
  - `400` → surface Toggl's validation message (e.g. missing `start_date`).
  - `401` → "check TOGGL_API_TOKEN".
  - `402`/`403` → feature not available on plan / no access to workspace.
  - `404` → workspace or saved report token not found.
- Guard: if the response `Content-Type` is JSON when a file was expected, treat it as
  an API error payload, not a file.

## Project structure

```
toggl-report-mcp/
├── src/
│   ├── index.ts          # entry: build server, connect StdioServerTransport
│   ├── config.ts         # env parsing + validation (zod)
│   ├── toggl-client.ts   # fetch wrapper: auth, retries, error mapping
│   ├── exports.ts        # export-dir resolution, filename sanitizing, file writes
│   └── tools/
│       ├── detailed.ts
│       ├── summary.ts
│       ├── weekly.ts
│       ├── saved.ts
│       └── list-exports.ts
├── test/                 # vitest unit tests (mocked fetch + tmp dirs)
├── package.json          # bin: "toggl-report-mcp", type: module
├── tsconfig.json
└── README.md             # setup, env vars, client config snippets
```

Stack: TypeScript, `@modelcontextprotocol/sdk`, `zod`, `vitest`, `tsx` for dev. No
other runtime dependencies. `package.json` gets a `bin` entry so clients can run it
via `npx`/node path in their MCP config.

## Testing strategy

- **Unit tests (vitest)**: config validation, filename sanitization/path-traversal
  guard, URL construction per report type/format, error mapping, 429 retry, and
  file-writing against a temp directory using a mocked `fetch`.
- **Integration smoke test**: run the built server against a tiny local HTTP stub
  (via `TOGGL_API_BASE_URL`) and drive it as a real MCP client over stdio to verify
  end-to-end tool calls produce files on disk.
- **Manual verification**: `npx @modelcontextprotocol/inspector node dist/index.js`
  and a real Cursor/Claude Desktop config example in the README.

## Implementation order

1. Scaffold: package.json, tsconfig, SDK + stdio wiring, config loading, export-dir
   startup validation. Server starts and lists zero tools.
2. Toggl HTTP client with auth, timeout, retry, and error mapping.
3. File writer (sanitization, collision handling) + `export_detailed_report` for both
   formats end-to-end.
4. Remaining tools: summary, weekly, saved, `list_report_exports`.
5. Tests, README (env vars, MCP client config snippets), npm scripts (`build`,
   `dev`, `test`).

## Open questions

1. **Report types**: the plan covers all four (detailed, summary, weekly, saved).
   If only one is actually needed (e.g. detailed), steps 4 shrinks accordingly —
   the architecture doesn't change.
2. **Filter breadth**: start with the common filters listed above rather than the
   full ~25-field body? Uncommon fields can be added to the schemas later without
   breaking changes.
3. **Overwrite behavior**: plan says never overwrite (suffix on collision); an
   `overwrite: true` tool flag could be added if regenerating in place is desired.
