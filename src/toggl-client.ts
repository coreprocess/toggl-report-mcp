import type { Config } from './config.js';
import { ToolError } from './errors.js';
import type { ExportFormat } from './exports.js';

export interface Workspace {
  id: number;
  name: string;
}

export type ReportType = 'detailed' | 'summary' | 'weekly';

export interface FileResult {
  bytes: Buffer;
  contentDispositionFilename?: string;
}

interface HttpResult {
  status: number;
  headers: Headers;
  bytes: Buffer;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  /** Wall-clock deadline (ms epoch) shared across a whole tool call. */
  deadline?: number;
  /** Human-readable feature name used in 402 feature-gating errors. */
  feature: string;
}

/** Minimum spacing between outgoing request starts (Toggl leaky bucket ~1 req/s). */
const MIN_REQUEST_INTERVAL_MS = 1000;
/** Longest wait we auto-retry through; longer waits become structured errors. */
const MAX_AUTO_RETRY_WAIT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const WORKSPACE_CACHE_TTL_MS = 60 * 60 * 1000;

const REPORT_PATHS: Record<ReportType, string> = {
  detailed: 'search/time_entries',
  summary: 'summary/time_entries',
  weekly: 'weekly/time_entries',
};

const WORKSPACE_TIP =
  'Pass workspace_id explicitly, or set TOGGL_DEFAULT_WORKSPACE_ID in your MCP server environment.';

function cancelledError(): ToolError {
  return new ToolError('CANCELLED', 'The tool call was cancelled.');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Resolves/rejects with `promise`, but rejects early with CANCELLED when the
 * caller's signal aborts. Used to detach joiners of a shared in-flight request
 * from each other: one caller's cancellation must not cancel the others.
 */
function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Parses Retry-After in both RFC forms: delta-seconds and HTTP-date. */
export function parseRetryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

function parseContentDispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*(?:utf-8''|UTF-8'')([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || undefined;
}

/**
 * Reads the response body with a hard size cap. Bodies are buffered (bounded)
 * rather than streamed to disk: validation (%PDF- magic, CSV sniffing) and
 * row counting need the bytes anyway, and the cap keeps memory bounded.
 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const tooLarge = () =>
    new ToolError(
      'RESPONSE_TOO_LARGE',
      `The Toggl API response exceeds the configured limit of ${Math.round(maxBytes / (1024 * 1024))} MB. ` +
        'Narrow the date range or raise TOGGL_MAX_EXPORT_MB.',
    );
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw tooLarge();
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw tooLarge();
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export class TogglClient {
  private queueTail: Promise<void> = Promise.resolve();
  private lastRequestStart = 0;
  private workspaceCache: { fetchedAt: number; workspaces: Workspace[] } | null = null;
  private workspacesInflight: Promise<Workspace[]> | null = null;

  constructor(private readonly config: Config) {}

  get hasDefaultWorkspace(): boolean {
    return this.config.defaultWorkspaceId !== undefined;
  }

  /** Total wall-clock budget for one tool call (requests + retries + waits). */
  createCallDeadline(): number {
    return Date.now() + this.config.requestTimeoutMs * 2;
  }

  private get token(): string {
    if (!this.config.apiToken) {
      throw new ToolError('CONFIG_ERROR', 'No Toggl API token is configured.', {
        tip: 'Set TOGGL_API_KEY (or the aliases TOGGL_API_TOKEN / TOGGL_TOKEN) in the MCP server environment. Find your token at https://track.toggl.com/profile.',
      });
    }
    return this.config.apiToken;
  }

  /**
   * Serializes all outgoing requests through a single queue with a minimum
   * inter-request interval, so concurrent tool calls cannot blow through
   * Toggl's ~1 req/s leaky bucket and self-inflict 429s. The wait is
   * cancellation-aware: a cancelled call gives up its queue slot immediately.
   */
  private async scheduled<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const prev = this.queueTail;
    let release!: () => void;
    this.queueTail = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      if (signal?.aborted) throw cancelledError();
      const wait = this.lastRequestStart + MIN_REQUEST_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait, signal);
      this.lastRequestStart = Date.now();
      return await fn();
    } finally {
      release();
    }
  }

  private async attempt(url: string, options: RequestOptions): Promise<HttpResult> {
    // Resolved outside the fetch try-block so a missing token surfaces as
    // CONFIG_ERROR instead of being wrapped as a network failure.
    const authorization = `Basic ${Buffer.from(`${this.token}:api_token`).toString('base64')}`;
    return this.scheduled(async () => {
      const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
      const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
      try {
        const response = await fetch(url, {
          method: options.method,
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/json',
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal,
        });
        // The body read must stay inside this try-block: for large exports the
        // download IS the request, and aborts during it must be classified as
        // CANCELLED/TIMEOUT, not as retriable network errors.
        const bytes = await readBodyCapped(response, this.config.maxExportBytes);
        return { status: response.status, headers: response.headers, bytes };
      } catch (err) {
        if (err instanceof ToolError) throw err;
        if (options.signal?.aborted) throw cancelledError();
        if (timeout.aborted) {
          throw new ToolError(
            'TIMEOUT',
            `The Toggl API did not respond within ${this.config.requestTimeoutMs} ms. ` +
              'Large exports can be slow; consider a smaller date range or a higher TOGGL_REQUEST_TIMEOUT_MS.',
          );
        }
        throw new ToolError('NETWORK_ERROR', `Could not reach the Toggl API: ${(err as Error).message}`);
      }
    }, options.signal);
  }

  private async request(url: string, options: RequestOptions): Promise<HttpResult> {
    // Retries stay within a wall-clock budget (shared across the whole tool
    // call when the caller provides a deadline) so a tool call cannot outlive
    // the client's own tool-call timeout by stacking waits.
    const deadline = options.deadline ?? this.createCallDeadline();
    let lastError: ToolError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (options.signal?.aborted) throw cancelledError();

      let result: HttpResult;
      try {
        result = await this.attempt(url, options);
      } catch (err) {
        const toolError =
          err instanceof ToolError
            ? err
            : new ToolError('NETWORK_ERROR', `Toggl API request failed: ${(err as Error).message}`);
        // Only transient network failures are retried; everything else
        // (CANCELLED, TIMEOUT, CONFIG_ERROR, RESPONSE_TOO_LARGE, ...) is final.
        if (toolError.code !== 'NETWORK_ERROR') throw toolError;
        lastError = toolError;
        const wait = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        if (attempt === MAX_ATTEMPTS || Date.now() + wait > deadline) throw toolError;
        await sleep(wait, options.signal);
        continue;
      }

      if (result.status === 429) {
        const retryAfterMs = parseRetryAfterMs(result.headers.get('retry-after'));
        const wait = retryAfterMs ?? 1000 * attempt;
        if (attempt === MAX_ATTEMPTS || wait > MAX_AUTO_RETRY_WAIT_MS || Date.now() + wait > deadline) {
          const reason =
            wait > MAX_AUTO_RETRY_WAIT_MS
              ? `Toggl asked to wait ${Math.round(wait / 1000)}s before retrying, which exceeds the automatic retry budget.`
              : 'The Toggl API rate limit (~1 request/second) was hit and automatic retries were exhausted.';
          throw new ToolError('RATE_LIMITED', reason, { retry_after_ms: wait });
        }
        lastError = new ToolError('RATE_LIMITED', 'Rate limited.', { retry_after_ms: wait });
        await sleep(wait, options.signal);
        continue;
      }

      if (result.status >= 500) {
        lastError = new ToolError(
          'UPSTREAM_ERROR',
          `The Toggl API returned HTTP ${result.status}: ${this.errorExcerpt(result.bytes)}`,
        );
        const wait = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        if (attempt === MAX_ATTEMPTS || Date.now() + wait > deadline) throw lastError;
        await sleep(wait, options.signal);
        continue;
      }

      if (result.status >= 400) {
        throw this.mapClientError(result, options.feature);
      }

      if (result.status !== 200) {
        // fetch follows redirects, so anything else (204, 206, ...) is not a
        // complete report file and must not be written to disk.
        throw new ToolError(
          'INVALID_RESPONSE',
          `The Toggl API returned unexpected HTTP status ${result.status}.`,
        );
      }

      return result;
    }

    throw lastError ?? new ToolError('INTERNAL_ERROR', 'Toggl API request failed unexpectedly.');
  }

  private errorExcerpt(bytes: Buffer): string {
    const text = bytes.toString('utf8').replace(/\s+/g, ' ').trim();
    if (text === '') return '(empty response body)';
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  }

  private mapClientError(result: HttpResult, feature: string): ToolError {
    const { status, headers } = result;
    if (status === 402) {
      // Presence of either quota header marks quota exhaustion; 402 without
      // them is paid-feature gating.
      if (headers.has('x-toggl-quota-remaining') || headers.has('x-toggl-quota-resets-in')) {
        const resetsInHeader = headers.get('x-toggl-quota-resets-in');
        const resetsIn = resetsInHeader === null ? NaN : Number(resetsInHeader);
        return new ToolError(
          'TOGGL_QUOTA_EXCEEDED',
          'The hourly Toggl API quota for this token is exhausted.',
          {
            resets_in_seconds: Number.isFinite(resetsIn) ? resetsIn : undefined,
            tip: 'Wait for the quota window to reset before retrying. Free plans allow as few as 30 requests/hour.',
          },
        );
      }
      return new ToolError(
        'FEATURE_UNAVAILABLE',
        `Toggl reports that ${feature} is not available on this workspace's plan (HTTP 402).`,
        { tip: 'CSV exports of some reports are a paid-plan feature; PDF export may still work.' },
      );
    }
    if (status === 401 || status === 403) {
      // Toggl documents HTTP 403 for failed authentication, so both statuses
      // are candidate auth failures.
      return new ToolError(
        'AUTH_FAILED',
        `Toggl rejected the request (HTTP ${status}). This usually means the API token is wrong ` +
          '(check TOGGL_API_KEY for typos or stray whitespace) or the token has no access to the requested workspace.',
      );
    }
    if (status === 404) {
      return new ToolError(
        'NOT_FOUND',
        'The Toggl API returned HTTP 404: the workspace does not exist or is not accessible with this token.',
      );
    }
    return new ToolError(
      'INVALID_REQUEST',
      `The Toggl API rejected the request (HTTP ${status}): ${this.errorExcerpt(result.bytes)}`,
    );
  }

  /** Returns the cached workspace list when fresh, without any API call. */
  getCachedWorkspaces(): Workspace[] | null {
    if (this.workspaceCache && Date.now() - this.workspaceCache.fetchedAt < WORKSPACE_CACHE_TTL_MS) {
      return this.workspaceCache.workspaces;
    }
    return null;
  }

  /**
   * Lists workspaces accessible to the token. Cached with a TTL (workspace
   * membership can change under a long-lived server); failures and empty
   * lists are never cached, and concurrent lookups are deduplicated, which
   * matters because /me/* calls draw from a strict user-scoped hourly quota.
   * The shared in-flight request runs detached from any caller's abort
   * signal so one caller's cancellation cannot cancel the others; each
   * caller races the shared promise against its own signal instead.
   */
  async getWorkspaces(signal?: AbortSignal, deadline?: number): Promise<Workspace[]> {
    const cached = this.getCachedWorkspaces();
    if (cached) return cached;
    if (!this.workspacesInflight) {
      this.workspacesInflight = this.fetchWorkspaces(deadline).finally(() => {
        this.workspacesInflight = null;
      });
      // Joiners may detach on abort; keep the shared promise from surfacing
      // an unhandled rejection when nobody is left listening.
      this.workspacesInflight.catch(() => {});
    }
    return raceWithAbort(this.workspacesInflight, signal);
  }

  private async fetchWorkspaces(deadline?: number): Promise<Workspace[]> {
    const result = await this.request(`${this.config.apiBaseUrl}/api/v9/me/workspaces`, {
      method: 'GET',
      deadline,
      feature: 'workspace listing',
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.bytes.toString('utf8'));
    } catch {
      throw new ToolError('INVALID_RESPONSE', 'The Toggl workspace listing was not valid JSON.');
    }
    if (!Array.isArray(parsed)) {
      throw new ToolError('INVALID_RESPONSE', 'The Toggl workspace listing had an unexpected shape.');
    }
    const workspaces: Workspace[] = parsed
      .filter(
        (item): item is { id: number; name: string } =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { id?: unknown }).id === 'number' &&
          typeof (item as { name?: unknown }).name === 'string',
      )
      .map((item) => ({ id: item.id, name: item.name }));
    if (workspaces.length !== parsed.length) {
      // A partially malformed listing must not silently narrow (or empty)
      // the workspace set: that could auto-pick the wrong workspace.
      throw new ToolError('INVALID_RESPONSE', 'The Toggl workspace listing had an unexpected shape.');
    }
    if (workspaces.length > 0) {
      this.workspaceCache = { fetchedAt: Date.now(), workspaces };
    }
    return workspaces;
  }

  /**
   * Resolution chain: explicit tool argument -> TOGGL_DEFAULT_WORKSPACE_ID ->
   * auto-pick when exactly one workspace is accessible -> WORKSPACE_REQUIRED
   * error listing the available workspaces (mirrors mcp-toggl's
   * WorkspaceResolutionError payload).
   */
  async resolveWorkspaceId(
    explicit: number | undefined,
    action: string,
    signal?: AbortSignal,
    deadline?: number,
  ): Promise<number> {
    if (explicit !== undefined) return explicit;
    if (this.config.defaultWorkspaceId !== undefined) return this.config.defaultWorkspaceId;

    const workspaces = await this.getWorkspaces(signal, deadline);
    const first = workspaces[0];
    if (workspaces.length === 1 && first) return first.id;

    if (workspaces.length === 0) {
      throw new ToolError(
        'WORKSPACE_REQUIRED',
        `Workspace ID required for ${action}, but no Toggl workspaces were returned.`,
        { tip: WORKSPACE_TIP, available_workspaces: [] },
      );
    }
    const listing = workspaces.map((ws) => `${ws.id} (${ws.name})`).join(', ');
    throw new ToolError(
      'WORKSPACE_REQUIRED',
      `Workspace ID required for ${action}. Set TOGGL_DEFAULT_WORKSPACE_ID or provide workspace_id. ` +
        `Available workspaces: ${listing}`,
      { tip: WORKSPACE_TIP, available_workspaces: workspaces },
    );
  }

  /**
   * Runs a report export and returns the validated file bytes. Response
   * validation is positive and status-first: Toggl 4xx bodies are frequently
   * bare text/plain strings, so content-type sniffing alone is not enough.
   */
  async exportReport(params: {
    reportType: ReportType;
    format: ExportFormat;
    workspaceId: number;
    body: Record<string, unknown>;
    signal?: AbortSignal;
    deadline?: number;
    /**
     * Attach the accessible-workspace list to AUTH_FAILED errors. The cached
     * list is always used when fresh; a fresh lookup is only spent when the
     * caller opts in (i.e. the workspace ID came from the tool argument or
     * the env default, where "wrong workspace" is the likely cause) — /me/*
     * requests draw from a scarce hourly quota.
     */
    enrichAuthErrors?: boolean;
  }): Promise<FileResult> {
    const { reportType, format, workspaceId, body, signal, deadline } = params;
    const url =
      `${this.config.apiBaseUrl}/reports/api/v3/workspace/${workspaceId}/` +
      `${REPORT_PATHS[reportType]}.${format}`;
    const feature = `${format.toUpperCase()} export of the ${reportType} report`;

    let result: HttpResult;
    try {
      result = await this.request(url, { method: 'POST', body, signal, deadline, feature });
    } catch (err) {
      if (err instanceof ToolError && err.code === 'AUTH_FAILED') {
        let workspaces = this.getCachedWorkspaces();
        if (!workspaces && params.enrichAuthErrors) {
          try {
            workspaces = await this.getWorkspaces(signal, deadline);
          } catch {
            workspaces = null;
          }
        }
        if (workspaces && workspaces.length > 0) {
          throw new ToolError(err.code, err.message, {
            ...err.extra,
            available_workspaces: workspaces,
          });
        }
      }
      throw err;
    }

    const { bytes } = result;
    if (bytes.length === 0) {
      throw new ToolError('INVALID_RESPONSE', 'The Toggl API returned an empty response body.');
    }
    if (format === 'pdf') {
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        throw new ToolError(
          'INVALID_RESPONSE',
          `The Toggl API response is not a PDF document: ${this.errorExcerpt(bytes)}`,
        );
      }
    } else {
      const head = bytes.toString('utf8', 0, Math.min(bytes.length, 256)).trimStart();
      if (head.startsWith('{') || head.startsWith('[') || head.startsWith('<')) {
        throw new ToolError(
          'INVALID_RESPONSE',
          `The Toggl API response does not look like CSV: ${this.errorExcerpt(bytes)}`,
        );
      }
    }
    return {
      bytes,
      contentDispositionFilename: parseContentDispositionFilename(
        result.headers.get('content-disposition'),
      ),
    };
  }
}
