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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ToolError('CANCELLED', 'The tool call was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

export class TogglClient {
  private queueTail: Promise<void> = Promise.resolve();
  private lastRequestStart = 0;
  private workspaceCache: { fetchedAt: number; workspaces: Workspace[] } | null = null;
  private workspacesInflight: Promise<Workspace[]> | null = null;

  constructor(private readonly config: Config) {}

  private get token(): string {
    if (!this.config.apiToken) {
      throw new ToolError(
        'CONFIG_ERROR',
        'No Toggl API token is configured.',
        {
          tip: 'Set TOGGL_API_KEY (or the aliases TOGGL_API_TOKEN / TOGGL_TOKEN) in the MCP server environment. Find your token at https://track.toggl.com/profile.',
        },
      );
    }
    return this.config.apiToken;
  }

  /**
   * Serializes all outgoing requests through a single queue with a minimum
   * inter-request interval, so concurrent tool calls cannot blow through
   * Toggl's ~1 req/s leaky bucket and self-inflict 429s.
   */
  private async scheduled<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queueTail;
    let release!: () => void;
    this.queueTail = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      const wait = this.lastRequestStart + MIN_REQUEST_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
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
      let response: Response;
      try {
        response = await fetch(url, {
          method: options.method,
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/json',
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal,
        });
      } catch (err) {
        if (options.signal?.aborted) {
          throw new ToolError('CANCELLED', 'The tool call was cancelled.');
        }
        if (timeout.aborted) {
          throw new ToolError(
            'TIMEOUT',
            `The Toggl API did not respond within ${this.config.requestTimeoutMs} ms. ` +
              'Large exports can be slow; consider a smaller date range or a higher TOGGL_REQUEST_TIMEOUT_MS.',
          );
        }
        throw new ToolError('NETWORK_ERROR', `Could not reach the Toggl API: ${(err as Error).message}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, bytes };
    });
  }

  private async request(url: string, options: RequestOptions): Promise<HttpResult> {
    // Retries stay within a total budget so a tool call cannot outlive the
    // client's own tool-call timeout by stacking waits.
    const deadline = Date.now() + this.config.requestTimeoutMs * 2;
    let lastError: ToolError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let result: HttpResult;
      try {
        result = await this.attempt(url, options);
      } catch (err) {
        const toolError =
          err instanceof ToolError
            ? err
            : new ToolError('NETWORK_ERROR', `Toggl API request failed: ${(err as Error).message}`);
        if (
          toolError.code === 'CANCELLED' ||
          toolError.code === 'CONFIG_ERROR' ||
          toolError.code === 'TIMEOUT'
        ) {
          throw toolError;
        }
        lastError = toolError;
        const wait = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        if (attempt === MAX_ATTEMPTS || Date.now() + wait > deadline) throw toolError;
        await sleep(wait, options.signal);
        continue;
      }

      if (result.status === 429) {
        const retryAfterSeconds = Number(result.headers.get('retry-after'));
        const wait =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : 1000 * attempt;
        lastError = new ToolError(
          'RATE_LIMITED',
          'The Toggl API rate limit (~1 request/second) was hit and retries were exhausted.',
          { retry_after_ms: wait },
        );
        if (attempt === MAX_ATTEMPTS || wait > MAX_AUTO_RETRY_WAIT_MS || Date.now() + wait > deadline) {
          throw lastError;
        }
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
      const resetsInHeader = headers.get('x-toggl-quota-resets-in');
      const resetsIn = resetsInHeader === null ? NaN : Number(resetsInHeader);
      if (headers.has('x-toggl-quota-remaining') || Number.isFinite(resetsIn)) {
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

  /**
   * Lists workspaces accessible to the token. Cached with a TTL (workspace
   * membership can change under a long-lived server); failures are never
   * cached and concurrent lookups are deduplicated, which matters because
   * /me/* calls draw from a strict user-scoped hourly quota.
   */
  async getWorkspaces(signal?: AbortSignal): Promise<Workspace[]> {
    if (this.workspaceCache && Date.now() - this.workspaceCache.fetchedAt < WORKSPACE_CACHE_TTL_MS) {
      return this.workspaceCache.workspaces;
    }
    if (this.workspacesInflight) return this.workspacesInflight;

    this.workspacesInflight = (async () => {
      try {
        const result = await this.request(`${this.config.apiBaseUrl}/api/v9/me/workspaces`, {
          method: 'GET',
          signal,
          feature: 'workspace listing',
        });
        let parsed: unknown;
        try {
          parsed = JSON.parse(result.bytes.toString('utf8'));
        } catch {
          throw new ToolError(
            'INVALID_RESPONSE',
            'The Toggl workspace listing was not valid JSON.',
          );
        }
        if (!Array.isArray(parsed)) {
          throw new ToolError(
            'INVALID_RESPONSE',
            'The Toggl workspace listing had an unexpected shape.',
          );
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
        this.workspaceCache = { fetchedAt: Date.now(), workspaces };
        return workspaces;
      } finally {
        this.workspacesInflight = null;
      }
    })();
    return this.workspacesInflight;
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
  ): Promise<number> {
    if (explicit !== undefined) return explicit;
    if (this.config.defaultWorkspaceId !== undefined) return this.config.defaultWorkspaceId;

    const workspaces = await this.getWorkspaces(signal);
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
  }): Promise<FileResult> {
    const { reportType, format, workspaceId, body, signal } = params;
    const url =
      `${this.config.apiBaseUrl}/reports/api/v3/workspace/${workspaceId}/` +
      `${REPORT_PATHS[reportType]}.${format}`;
    const feature = `${format.toUpperCase()} export of the ${reportType} report`;

    let result: HttpResult;
    try {
      result = await this.request(url, { method: 'POST', body, signal, feature });
    } catch (err) {
      // A 403 with an explicit/default workspace ID is often a wrong
      // workspace rather than a bad token; attach the available workspaces
      // (best effort) so the model can self-correct.
      if (err instanceof ToolError && err.code === 'AUTH_FAILED') {
        try {
          const workspaces = await this.getWorkspaces(signal);
          throw new ToolError(err.code, err.message, {
            ...err.extra,
            available_workspaces: workspaces,
          });
        } catch (enriched) {
          if (enriched instanceof ToolError && enriched.code === 'AUTH_FAILED') throw enriched;
          throw err;
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
