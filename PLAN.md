# Plan: Toggl Report MCP Server (Node.js, stdio)

An MCP server that exposes the Toggl Reports API v3 export endpoints as MCP tools,
letting an MCP client (Cursor, Claude Desktop, etc.) create **PDF** and **CSV** report
exports and save them to a locally configured directory.

> This revision incorporates the findings of a three-model design review
> (cross-checked against the official Toggl docs and the mcp-toggl source). Resolved
> decisions are collected at the end of the document.

## Scope

- **In scope (v1)**
  - Node.js MCP server using the official `@modelcontextprotocol/sdk`.
  - **stdio transport only** (no HTTP/SSE transport for now).
  - Tools that create PDF and CSV exports of **detailed**, **summary**, and
    **weekly** reports via the Toggl Reports API v3.
  - Local state: an export directory configured via environment variable where all
    generated report files are written.
- **Deferred (post-v1)**
  - **Saved/shared report exports** (`/reports/api/v3/shared/{report_token}/...`).
    Cut from v1 on review: there is no API to list saved reports, so a model can
    never discover a `report_token` on its own (the user must hand-copy it from the
    web UI share URL), and the feature is paid-plan only. Revisit once verified
    against a real paid workspace; the tool description must then explain where the
    token comes from, and default filenames must not embed the token (see File
    handling).
  - **XLSX exports.** The endpoints are not uniformly format-parameterized across
    report types, so adding XLSX requires a verified per-report format matrix
    first; v1 stays at the two formats actually required (PDF, CSV).
  - Other transports (Streamable HTTP), reading/analyzing report contents (JSON
    report endpoints), MCP resources/prompts.
  - Everything `verygoodplugins/mcp-toggl` already does (see next section).

## Relationship to verygoodplugins/mcp-toggl

This server is designed as a **complement** to
[`verygoodplugins/mcp-toggl`](https://github.com/verygoodplugins/mcp-toggl), which
covers the live Toggl **API v9** surface: timer control, hydrated time-entry queries,
desktop-activity timelines, workspace/project/client lookups, and structured
in-memory report summaries. It does **not** produce report files — its
`toggl_daily_report`/`toggl_weekly_report` tools return text/JSON for the model to
synthesize. Our server fills exactly that gap: official **Reports API v3** file
exports (PDF/CSV) written to disk. No functional overlap.

Since users will likely run both servers side by side in the same MCP client config,
we align the **public contract** (not their internals) so the pair feels like one
product family:

- **Shared env vars**: same names for shared settings — `TOGGL_API_KEY` preferred,
  with `TOGGL_API_TOKEN` and `TOGGL_TOKEN` accepted as aliases (all three, exactly
  as mcp-toggl does), and `TOGGL_DEFAULT_WORKSPACE_ID` — so users can copy the same
  `env` block to both servers. Only `TOGGL_EXPORT_DIR` is unique to us.
- **Tool naming**: they prefix every tool with `toggl_`. We adopt the same prefix
  with an `export` stem (`toggl_export_*`), which groups our tools visually and
  guarantees no name collisions. Because the model will see both
  `toggl_weekly_report` (returns JSON) and `toggl_export_weekly_report` (writes a
  file), every export tool description opens with an explicit disambiguator:
  *"Writes a PDF/CSV file to disk; use this when the user wants a report file they
  can keep or send."*
- **Workspace resolution parity**: we mirror their `WorkspaceResolutionError`
  payload shape — code `WORKSPACE_REQUIRED`, `available_workspaces: [{id, name}]`,
  `tip` — so a model that learned to recover from one server's error handles the
  other identically. Note one deliberate divergence: mcp-toggl never sets MCP's
  `isError` flag (it returns error JSON as plain text); we *do* set
  `isError: true`, which is the correct MCP behavior. What we mirror is the JSON
  body shape inside the text content, not the flag.
- **Stack parity (dependencies, not code style)**: same dependencies and toolchain
  (TypeScript, `@modelcontextprotocol/sdk` ^1.x — v2 is still beta — `zod` v4
  pinned to a version the SDK release supports, `dotenv`, `vitest`, `tsx`,
  ESLint + Prettier) and same Node engines range (`^20.19.0 || >=22.12.0`).
  Note: mcp-toggl uses the low-level `Server` + `setRequestHandler` API with
  hand-written JSON Schema; we use the higher-level `McpServer.registerTool` with
  zod, which is the better current practice — so tool-registration code will look
  different between the repos.
- **Patterns worth copying**: their stdio smoke test that boots the built server
  and exercises it over the wire; structured rate-limit errors with retry hints and
  a bounded auto-retry budget (`MAX_AUTO_RETRY_MS`); never echoing the token;
  `.env.example` + `dotenv` loaded with `{ quiet: true }` (see stdio hygiene).

## Toggl Reports API v3 background

Base URL: `https://api.track.toggl.com`. All export endpoints are `POST` with a JSON
filter body and HTTP Basic auth. The v1 endpoints:

| Report type | PDF | CSV |
| --- | --- | --- |
| Detailed | `/reports/api/v3/workspace/{workspace_id}/search/time_entries.pdf` | `.../search/time_entries.csv` |
| Summary | `/reports/api/v3/workspace/{workspace_id}/summary/time_entries.pdf` | `.../summary/time_entries.csv` |
| Weekly | `/reports/api/v3/workspace/{workspace_id}/weekly/time_entries.pdf` | `.../weekly/time_entries.csv` |

Authentication: Toggl API token as Basic auth username with the literal string
`api_token` as the password (preferred over email/password so we never handle a real
password). **Important:** Toggl's docs state that failed authentication returns
**HTTP 403**, not 401 (the shared-report endpoints separately document 401), so
error mapping must treat both as candidate auth failures.

Rate limiting — Toggl has **two independent mechanisms**:

1. **Leaky bucket**: ~1 request/second per token+IP is the safe rate; violations
   return **429**. A `Retry-After` header is *not* guaranteed.
2. **Hourly quota**: a sliding-window quota (as low as 30 requests/hour on Free
   plans; higher on paid tiers, and a flat low quota for user-scoped calls like
   `/api/v9/me/workspaces`) that returns **HTTP 402** with
   `X-Toggl-Quota-Remaining` and `X-Toggl-Quota-Resets-In` headers. 402 is *also*
   used for paid-feature gating, so the two cases must be distinguished by the
   presence of the quota headers.

Plan gating: CSV exports of the detailed report and saved reports are paid-plan
features; a Free-plan user's first `format: "csv"` call may 402/403. Tool
descriptions and the README document this, and the feature-gating error message
names the specific feature so the model can fall back to PDF.

### Pagination risk (must verify during implementation)

The detailed export request bodies document `page_size` (**default 50**) and
`first_row_number`/`first_id` cursor fields. Whether the *file* endpoints honor
pagination (i.e. whether a CSV silently truncates at 50 rows) cannot be resolved
from the docs — the `X-Next-*` cursor response headers are documented only on the
JSON search endpoint. Since silent truncation of an invoice CSV is the worst
possible failure mode, this is a first-class implementation task:

- Always send an explicit, large `page_size` on detailed exports.
- Verify against a real account whether file exports truncate; if they do, loop on
  `first_row_number` and concatenate CSV pages (dropping repeated header rows), and
  for PDF return `truncated: true` + `next_row_number` in the structured result
  rather than attempting PDF merging.
- Assert expected row counts in the integration tests, and include a `row_count`
  (CSV) in the tool result so empty or suspiciously small exports are visible
  ("no time entries matched" instead of a silently empty file).

## Configuration (environment variables)

| Variable | Required | Description |
| --- | --- | --- |
| `TOGGL_API_KEY` | yes | Toggl Track API token. `TOGGL_API_TOKEN` and `TOGGL_TOKEN` accepted as aliases (same three names as mcp-toggl). |
| `TOGGL_EXPORT_DIR` | yes | **Absolute** directory path where exported files are written. Relative paths are rejected at startup (MCP hosts spawn stdio servers with an unpredictable working directory, often `/`). Created if missing (mode `0700` for newly created dirs); startup fails with a clear error if not writable. |
| `TOGGL_DEFAULT_WORKSPACE_ID` | no | Default workspace ID so tool calls can omit it. Validated at startup: must be a positive integer, otherwise fail fast (no silent ignore). |
| `TOGGL_API_BASE_URL` | no | Override for testing/mocking. Defaults to `https://api.track.toggl.com`. Must be HTTPS, except plain HTTP for loopback addresses (test stubs) — the Basic-auth header must never travel over cleartext to a remote host. |
| `TOGGL_REQUEST_TIMEOUT_MS` | no | Per-attempt request timeout, default `60000`. Large PDF exports can be slow. |

Configuration is validated once at startup. Diagnostics go to **stderr only** —
stdout is reserved for the MCP protocol. `dotenv` is loaded with
`config({ quiet: true })`: dotenv ≥17 prints an injection banner to *stdout* by
default, a known cause of "Invalid JSON-RPC message" disconnects in stdio clients.
The stdio smoke test asserts stdout purity (first bytes must be valid JSON-RPC) so
no dependency can regress this.

The README documents where common MCP clients write server stderr logs, since a
server that exits at startup surfaces only as "server disconnected" in most client
UIs.

## Workspace resolution

Workspace-scoped export tools (detailed, summary, weekly) resolve the workspace in
this order:

1. **`workspace_id` tool argument** — always wins if provided.
2. **`TOGGL_DEFAULT_WORKSPACE_ID` env var** — used when the tool call omits the
   argument.
3. **Auto-detection** — if neither is set, the server calls the Toggl main API
   (`GET /api/v9/me/workspaces`, same host and auth as the Reports API) to list the
   workspaces accessible to the token:
   - **Exactly one workspace** → use it as the obvious default.
   - **Multiple workspaces** → return a tool error that enumerates all accessible
     workspaces as `id` + `name` pairs and instructs the model to retry with an
     explicit `workspace_id`.
   - **Zero workspaces** → tool error explaining the token has no workspace access
     (mcp-toggl uses a distinct message for this case; we match that).

The error mirrors mcp-toggl's `WorkspaceResolutionError` payload: code
`WORKSPACE_REQUIRED`, message `Workspace ID required for {action}. Set
TOGGL_DEFAULT_WORKSPACE_ID or provide workspace_id. Available workspaces: 123456
(Acme Inc), 789012 (Personal)`, plus structured
`available_workspaces: [{id, name}]` and `tip` fields, serialized as JSON in the
text content of an `isError: true` result.

Implementation notes:

- Auto-detection lives in `toggl-client.ts` as `resolveWorkspaceId()` shared by all
  workspace-scoped tools.
- The workspace list is fetched lazily (first tool call that needs it, not at
  startup) and cached in memory with a modest TTL (e.g. 1 hour, matching
  mcp-toggl's default cache TTL) rather than for the process lifetime — membership
  and names can change under a long-lived server. Failed lookups are never cached,
  and concurrent lookups are deduplicated (single-flight). This matters doubly
  because `/me/*` calls draw from the strict user-scoped hourly quota.
- When a 403 follows an explicit or env-provided workspace ID, attach the same
  `available_workspaces` list to the error so the model can self-correct.
- The tool descriptions document this behavior so the model knows `workspace_id` is
  optional and what the error means.
- Unit tests cover all resolution branches (explicit arg, env default,
  single-workspace auto-pick, multi-workspace error listing, zero workspaces,
  non-numeric env value → startup failure).

## Tool surface

One tool per report type, each taking a `format: "pdf" | "csv"` parameter. Separate
tools (rather than one mega-tool with a `report_type` discriminator) keep each input
schema small and accurate, which helps LLM tool selection. Names use the `toggl_`
prefix for consistency with mcp-toggl and to avoid any collision with its tools.

The v1 filter surface is deliberately narrow — every extra field costs schema tokens
on every `tools/list` and is another thing a model can get wrong. Uncommon fields
can be added later without breaking changes.

1. **`toggl_export_detailed_report`**
   - Inputs: `format`, `start_date`, `end_date` (ISO `YYYY-MM-DD`), optional
     `workspace_id` (resolved per "Workspace resolution" above when omitted),
     optional filters: `project_ids`, `client_ids`, `tag_ids`, `user_ids`,
     `billable`, `description`, `duration_format` (`"classic" | "decimal" |
     "improved"` — the field CSV consumers most need), `hide_amounts`; optional
     `filename`.
   - Dropped from v1 after review: `rounding`/`rounding_minutes` (default from user
     preferences; overriding silently changes billable totals), `order_by`/
     `order_dir`, `grouped`, and all cosmetic PDF-only fields (`date_format`,
     `cents_separator`, `hour_format`, `display_mode`).
2. **`toggl_export_summary_report`**
   - Same core inputs plus `grouping` and `sub_grouping`.
   - `resolution` is **PDF-only** in the API; excluded from v1 rather than exposing
     a field that is silently ignored for CSV.
3. **`toggl_export_weekly_report`**
   - Same core inputs plus `calculate` and `group_by_task`. (`logo_url` is PDF-only
     cosmetic; excluded.)
4. **`toggl_list_report_exports`**
   - Lists files in the export directory so the model can find previous exports.
   - Inputs: optional `limit` (default 50). Returns newest-first, filtered to the
     extensions this server produces (`.pdf`, `.csv`) so pointing
     `TOGGL_EXPORT_DIR` at an existing folder doesn't dump unrelated files into
     context. Never follows symlinks.

Schema rules:

- Schemas only contain fields valid for **both** formats of that report type;
  format-specific fields are added only if scoped to the format via schema
  refinement with a clear validation message.
- Date handling: validate real calendar dates (not just a `YYYY-MM-DD` regex) and
  `start_date <= end_date` in zod. Requiring both dates is deliberately stricter
  than the API (which only demands "at least one parameter"); this is documented as
  an intentional contract. Single-day (`start_date == end_date`) and very long
  ranges get verified against the real API during implementation and covered in
  tests.
- Array filters support Toggl's `[null]` convention ("entries with no project /
  client / tag") where the API documents it.

MCP surface per current SDK best practice:

- Registered via `McpServer.registerTool` with zod schemas.
- Every tool declares a human-readable `title` and annotations:
  `readOnlyHint: true, idempotentHint: true` on `toggl_list_report_exports`;
  `readOnlyHint: false, destructiveHint: false, idempotentHint: false,
  openWorldHint: true` on the exporters.
- Export tools declare an `outputSchema` and return the result as
  `structuredContent` **plus** the same JSON serialized in a text block for
  backwards compatibility: absolute file path, file size, `format`, `report_type`,
  `requested_date_range` (named "requested" deliberately — it is what we sent, not
  proof of the file's contents), and `row_count` for CSV.
- A `resource_link` content block with the `file://` URI and correct MIME type
  accompanies successful exports.
- Error results set `isError: true`, carry the structured payload (`code`, `tip`,
  extra fields like `available_workspaces`) as JSON in the text content, and
  **omit** `structuredContent` (the SDK validates `structuredContent` against
  `outputSchema`, so error shapes must not be sent through it).

## File handling (the "local state")

- On startup: require an absolute `TOGGL_EXPORT_DIR`, resolve it with
  `fs.realpath` (so symlinked dirs can't redirect writes), `mkdir -p` it, and
  verify writability. Newly created directories get mode `0700`; existing
  directories are left untouched.
- Default filename pattern:
  `toggl-{report_type}-{start_date}_{end_date}-{yyyymmdd-hhmmss}.{ext}`.
  (When saved-report exports land post-v1, default filenames use a truncated hash
  of the report token, never the token itself — share tokens act as bearer
  credentials and must not leak into directory listings, shell history, or chat
  transcripts.)
- Caller-supplied `filename`: sanitize by stripping path separators, NUL and
  control characters, and trailing dots/spaces; reject `..` and Windows reserved
  names (`CON`, `PRN`, ...); cap length; force the correct extension. Containment
  is checked as `resolvedPath.startsWith(exportDirRealpath + path.sep)` after
  `path.resolve` (a plain `startsWith` would let `exports-evil` pass).
- **Atomic, race-free writes**: stream the response body to a temp file in the
  export directory, then `rename` into the final name created with the exclusive
  `wx` flag (`O_EXCL`), retrying with a numeric suffix on `EEXIST` so the OS — not
  a stat-then-write race — arbitrates collisions. Files are created with mode
  `0600`. Partial files are deleted on any failure (network error, timeout,
  cancellation).
- Bodies are streamed to disk, not buffered whole in memory; when buffering is
  unavoidable use `Buffer.from(await res.arrayBuffer())` — never `res.text()`,
  which corrupts PDF bytes via UTF-8 replacement.
- PDF/CSV bytes are written exactly as received (no re-encoding). If Toggl sends a
  usable `Content-Disposition` filename and the caller didn't pass `filename`, use
  it (after the same sanitizer) in preference to the generic default.

## HTTP client & error handling

Small internal client on top of Node's native `fetch`:

- Basic auth header built from `{token}:api_token`; the token value is never echoed
  in tool results, filenames, or error messages.
- **Request serialization**: all outgoing requests — exports *and* the
  `/me/workspaces` lookup — pass through a single in-process queue with a minimum
  inter-request interval (~1s), so concurrent tool calls can't blow through the
  leaky bucket and self-inflict 429s.
- Timeouts: per-attempt via `AbortSignal.timeout(TOGGL_REQUEST_TIMEOUT_MS)`,
  combined with the MCP cancellation signal, under a hard total budget per tool
  call so retries can't outlive the client's own tool-call timeout. Auto-retry only
  for short waits; otherwise return a structured retry hint (mcp-toggl's
  `MAX_AUTO_RETRY_MS` pattern).
- `429`: retry with backoff (honor `Retry-After` if present, but never depend on
  it), max 3 attempts within the total budget.
- `402`: check for `X-Toggl-Quota-Remaining` / `X-Toggl-Quota-Resets-In` headers.
  Present → distinct `TOGGL_QUOTA_EXCEEDED` error carrying `resets_in_seconds`; do
  not retry. Absent → paid-feature gating error naming the specific feature (e.g.
  "CSV export of detailed reports requires a paid plan") so the model can fall back
  to PDF.
- `401`/`403`: both treated as candidate auth failures (Toggl documents **403** for
  failed authentication) — one message covering both causes: bad/whitespace-padded
  token *or* no access to the workspace, mirroring mcp-toggl's
  `isAuth = status === 401 || status === 403`.
- `400` → surface Toggl's validation message (e.g. "At least one parameter must be
  set"). `404` → workspace not found. `5xx`/network errors → bounded, jittered
  retry, then a structured error.
- **Response validation, status first**: only 200 with a non-empty body is a file.
  Then validate positively — `%PDF-` magic bytes for PDF, non-empty and not
  HTML/JSON for CSV — rather than only sniffing for JSON error payloads (Toggl 4xx
  bodies are frequently bare `text/plain` strings). Upstream error bodies are
  bounded/truncated before being included in tool errors.
- Graceful shutdown: handle `SIGINT`/`SIGTERM` with `server.close()` so in-flight
  file operations clean up their temp files.

Startup failure behavior: a missing/invalid token does **not** hard-exit the server
(most clients would show only "server disconnected"); the server starts, lists tools
normally, and returns the configuration error as an `isError` tool result the user
actually reads in-chat. Only a genuinely unusable export directory (or invalid
`TOGGL_DEFAULT_WORKSPACE_ID`) aborts startup, with the reason on stderr.

## Project structure & packaging

```
toggl-report-mcp/
├── src/
│   ├── index.ts          # entry (shebang): build server, connect StdioServerTransport
│   ├── config.ts         # env parsing + validation (zod), alias handling
│   ├── toggl-client.ts   # fetch wrapper: auth, queue, retries, error mapping
│   ├── exports.ts        # export-dir resolution, filename sanitizing, atomic writes
│   └── tools/
│       ├── detailed.ts
│       ├── summary.ts
│       ├── weekly.ts
│       └── list-exports.ts
├── tests/                # vitest unit tests (mocked fetch + tmp dirs) + stdio smoke test
├── .github/workflows/ci.yml  # lint + build + test on PR
├── .env.example          # documented local-dev configuration
├── LICENSE               # MIT
├── package.json          # bin: "toggl-report-mcp", type: module, files allowlist
├── tsconfig.json         # NodeNext resolution, explicit .js extensions on imports
└── README.md             # setup, env vars, client config snippets, stderr log locations
```

Packaging details that break `npx` if forgotten:

- `dist/index.js` starts with `#!/usr/bin/env node` and gets the executable bit via
  `postbuild: chmod +x` (as mcp-toggl does).
- `files` allowlist (`dist/`, `README.md`, `LICENSE`), lockfile committed,
  `prepublishOnly: build && test`, and an `npm pack` execution test before first
  publish.
- Stack: TypeScript, `@modelcontextprotocol/sdk` ^1.x (v2 is still beta), `zod` v4
  pinned compatibly with the SDK release (mcp-toggl's SDK ^1.29 + zod ^4.3.6 is a
  known-good pairing), `dotenv` (loaded quiet), with `vitest`, `tsx`, ESLint and
  Prettier for development. Node engines `^20.19.0 || >=22.12.0`.
- If MCP-registry publication is wanted later: `server.json` + `package.json#mcpName`
  (mcp-toggl has both).

## Testing strategy

- **Unit tests (vitest)**: config validation (aliases, absolute-path rule, invalid
  default workspace ID), filename sanitization (traversal, `exports-evil` prefix
  case, control chars, Windows reserved names), URL construction per report
  type/format, error mapping (402-quota vs 402-feature, 401/403 auth, 400
  passthrough), 429 retry with budget, request-queue serialization under concurrent
  calls, workspace resolution (all branches), and atomic file writing against a
  temp directory using a mocked `fetch` — including concurrent collision, symlink
  destination, partial-write cleanup, empty-body rejection, and `%PDF-` magic-byte
  validation.
- **Integration smoke test**: run the built server against a tiny local HTTP stub
  (via `TOGGL_API_BASE_URL`) and drive it as a real MCP client over stdio: verify
  end-to-end tool calls produce files on disk, assert CSV row counts (pagination
  guard), and assert **stdout purity** (nothing but JSON-RPC on stdout from process
  start).
- **Credential-gated live contract test** (skipped without a real token): verifies
  the pagination question, single-day date ranges, and long-range behavior against
  the real API — the generated Toggl docs are incomplete and occasionally
  inconsistent, so one live check is worth more than doc archaeology.
- **Manual verification**: `npx @modelcontextprotocol/inspector node dist/index.js`
  and a real Cursor/Claude Desktop config example in the README.

## Implementation order

1. Scaffold: package.json (bin/shebang/files/engines), tsconfig, SDK + stdio
   wiring, config loading with aliases and absolute-path validation, export-dir
   startup handling. Server starts and lists zero tools; smoke test asserts stdout
   purity.
2. Toggl HTTP client: auth, single-flight request queue, timeout/cancellation
   budget, retry, full error mapping (429, 402-quota vs 402-feature, 401/403, 400,
   5xx), response validation.
3. File writer: sanitization, realpath containment, atomic `wx` + temp-rename
   writes, permissions, partial-file cleanup.
4. `toggl_export_detailed_report` end-to-end for both formats, including the
   **pagination verification task** (live check; loop-and-concatenate or
   `truncated` flag as findings dictate) and `row_count` reporting.
5. Remaining tools: summary, weekly, `toggl_list_report_exports`; workspace
   resolution with TTL cache.
6. Tests (unit + stdio smoke + credential-gated live), CI workflow, README
   (env vars, client config snippets, plan-gating notes, stderr log locations),
   LICENSE.

## Resolved decisions (from the design review)

1. **Saved-report tool cut from v1** — no API path for a model to discover a
   `report_token`; paid-only; endpoint shape inconsistently documented. Deferred
   with explicit re-entry criteria (verified against a paid workspace).
2. **XLSX deferred** — v1 ships the two required formats; XLSX needs a verified
   per-report format matrix first.
3. **402 handling split** into quota-exceeded (headers present, report reset time)
   vs paid-feature gating (headers absent, name the feature).
4. **Auth failures map 403 *and* 401 to token/access guidance** per Toggl's
   documented behavior.
5. **Filter surface trimmed**; `duration_format` added (highest-value missing
   field); PDF-only cosmetic fields excluded.
6. **MCP surface modernized**: `outputSchema` + `structuredContent`, `title`,
   annotations, `resource_link` blocks; errors as `isError: true` with JSON text
   payload and no `structuredContent`.
7. **File writes made atomic and symlink-safe**; relative export dirs rejected;
   restrictive permissions.
8. **dotenv loaded quiet** + stdout-purity test to protect the stdio protocol.
9. **Client-side request serialization** added on top of reactive 429 retries.
10. **Pagination truncation** treated as an unresolved API question with a
    mandatory empirical verification step and row-count reporting as a guardrail.

## Remaining open questions

1. **Pagination behavior of file exports** — resolved only by the live check in
   implementation step 4; both outcomes have a planned code path.
2. **Single-day and maximum date ranges** — Toggl docs suggest `end_date` must be
   greater than `start_date` and hint at a maximum supported period; verified live,
   then encoded in zod validation and error messages.
