/**
 * HTTP client for the Toggl APIs: the Reports API v3 for report data and downloads, plus
 * one Track API v9 call listing workspaces. All requests share one paced queue (Toggl allows
 * ~1 request/second), retry transient failures within a per-call deadline, honour
 * cancellation, cap response sizes and map every failure to an actionable ToolError.
 */

import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { ToolError } from '#errors/errors';
import {
  createCancelledError,
  type FileFormat,
  mapClientError,
  parseRetryAfterMs,
  readBodyCapped,
  sleepAbortable,
  summarizeBody,
  validateFileBytes,
} from './http.ts';

/** Longest server-requested wait retried automatically; longer waits become RATE_LIMITED. */
const MAX_AUTO_RETRY_WAIT_MS = 10_000;

/** Attempts per request, including the first one. */
const MAX_ATTEMPTS = 3;

/** Cancellation and time budget of one tool call, shared by all its requests. */
export interface CallContext {
  /** Aborts when the MCP client cancels the tool call. */
  signal: AbortSignal;
  /** Wall-clock deadline (epoch ms) after which no further retry is started. */
  deadline: number;
}

/** JSON response body plus the pagination cursors Toggl returns via headers. */
export interface JsonReportResult {
  /** Parsed response body. */
  body: unknown;
  /** Value of the X-Next-ID header; present when more pages exist. */
  nextId: string | undefined;
  /** Value of the X-Next-Row-Number header; present when more pages exist. */
  nextRowNumber: string | undefined;
}

/** One workspace the API token can access; unknown response fields are dropped. */
export const Workspace = z.object({
  id: z.number().int(),
  name: z.string(),
});
export type Workspace = z.infer<typeof Workspace>;

/** Construction bag for the client; fetch and pacing are injected so tests stay fast. */
export interface TogglClientParams {
  /** Toggl API token sent as basic auth `<token>:api_token`; undefined yields CONFIG_ERROR. */
  apiToken: string | undefined;
  /** API origin without a trailing slash; Reports and Track paths are appended. */
  baseUrl: string;
  /** Timeout of a single HTTP attempt in milliseconds. */
  requestTimeoutMs: number;
  /** Maximum accepted response size in bytes. */
  maxResponseBytes: number;
  /** Minimum spacing between request starts; ~1000 matches Toggl's leaky bucket. */
  minRequestIntervalMs: number;
  /** Fetch implementation performing the actual HTTP requests. */
  fetchImpl: typeof fetch;
}

/** Status, headers and fully read body of one HTTP exchange. */
interface HttpResult {
  /** HTTP status code. */
  status: number;
  /** Response headers. */
  headers: Headers;
  /** Response body, capped at the configured size. */
  bytes: Uint8Array;
}

/** One logical request, possibly spanning several attempts. */
interface RequestSpec {
  /** Absolute URL. */
  url: string;
  /** HTTP method. */
  method: 'GET' | 'POST';
  /** JSON body; undefined for GET. */
  body: Record<string, unknown> | undefined;
  /** Human-readable feature name used in paid-plan (HTTP 402) errors. */
  feature: string;
  /** Cancellation and deadline of the owning tool call. */
  call: CallContext;
}

/** Speaks to the Toggl APIs; report endpoints are JSON POSTs, workspace listing is a GET. */
export class TogglClient {
  readonly #apiToken: string | undefined;

  readonly #reportsBaseUrl: string;

  readonly #trackBaseUrl: string;

  readonly #requestTimeoutMs: number;

  readonly #maxResponseBytes: number;

  readonly #minRequestIntervalMs: number;

  readonly #fetch: typeof fetch;

  /** Tail of the request queue; each request waits for its predecessor. */
  #queueTail: Promise<void> = Promise.resolve();

  /** Start time (epoch ms) of the most recent request, for pacing. */
  #lastRequestStart = 0;

  constructor(params: TogglClientParams) {
    this.#apiToken = params.apiToken;
    this.#reportsBaseUrl = `${params.baseUrl}/reports/api/v3`;
    this.#trackBaseUrl = `${params.baseUrl}/api/v9`;
    this.#requestTimeoutMs = params.requestTimeoutMs;
    this.#maxResponseBytes = params.maxResponseBytes;
    this.#minRequestIntervalMs = params.minRequestIntervalMs;
    this.#fetch = params.fetchImpl;
  }

  /** Creates the budget for one tool call: two request timeouts cover retries and waits. */
  createCallContext(signal: AbortSignal): CallContext {
    return { signal, deadline: Date.now() + this.#requestTimeoutMs * 2 };
  }

  /** POSTs to a JSON report endpoint and returns the parsed body with pagination cursors. */
  async requestJson(params: {
    path: string;
    body: Record<string, unknown>;
    call: CallContext;
  }): Promise<JsonReportResult> {
    const result = await this.#request({
      url: `${this.#reportsBaseUrl}${params.path}`,
      method: 'POST',
      body: params.body,
      feature: 'this report',
      call: params.call,
    });
    return {
      body: parseJsonBody(result.bytes),
      nextId: result.headers.get('X-Next-ID') ?? undefined,
      nextRowNumber: result.headers.get('X-Next-Row-Number') ?? undefined,
    };
  }

  /** POSTs to an export endpoint and returns file content validated against the format. */
  async requestFile(params: {
    path: string;
    body: Record<string, unknown>;
    format: FileFormat;
    feature: string;
    call: CallContext;
  }): Promise<Uint8Array> {
    const result = await this.#request({
      url: `${this.#reportsBaseUrl}${params.path}`,
      method: 'POST',
      body: params.body,
      feature: params.feature,
      call: params.call,
    });
    validateFileBytes(result.bytes, params.format);
    return result.bytes;
  }

  /** Lists the workspaces the API token can access, reduced to id and name. */
  async listWorkspaces(call: CallContext): Promise<Workspace[]> {
    const result = await this.#request({
      url: `${this.#trackBaseUrl}/me/workspaces`,
      method: 'GET',
      body: undefined,
      feature: 'workspace listing',
      call,
    });

    // A partially malformed listing must not silently narrow the set and auto-pick wrongly.
    const parsed = z.array(Workspace).safeParse(parseJsonBody(result.bytes));
    if (!parsed.success) {
      throw new ToolError(
        'INVALID_RESPONSE',
        'The Toggl workspace listing had an unexpected shape.',
        {},
      );
    }
    return parsed.data;
  }

  /** Runs a request with retries for network errors, 429 and 5xx within the call deadline. */
  async #request(spec: RequestSpec): Promise<HttpResult> {
    const { call } = spec;
    // Unbounded on purpose: every retry path goes through #backoff, which throws at MAX_ATTEMPTS.
    for (let attempt = 1; ; attempt++) {
      // Transient network failures are retried with backoff; every other error is final.
      let result: HttpResult;
      try {
        result = await this.#attempt(spec);
      } catch (err) {
        if (!(err instanceof ToolError && err.code === 'NETWORK_ERROR')) {
          throw err;
        }
        await this.#backoff({ attempt, wait: computeBackoffMs(attempt), call, failure: err });
        continue;
      }

      // Rate limited: honour Retry-After when it fits the budget, otherwise report it.
      if (result.status === 429) {
        const wait = parseRetryAfterMs(result.headers.get('retry-after')) ?? 1000 * attempt;
        const reason =
          wait > MAX_AUTO_RETRY_WAIT_MS
            ? `Toggl asked to wait ${Math.round(wait / 1000)}s before retrying, which exceeds the automatic retry budget.`
            : 'The Toggl API rate limit (~1 request/second) was hit and automatic retries were exhausted.';
        const failure = new ToolError('RATE_LIMITED', reason, { retry_after_ms: wait });
        if (wait > MAX_AUTO_RETRY_WAIT_MS) {
          throw failure;
        }
        await this.#backoff({ attempt, wait, call, failure });
        continue;
      }

      // Server-side failures are usually transient.
      if (result.status >= 500) {
        const failure = new ToolError(
          'UPSTREAM_ERROR',
          `The Toggl API returned HTTP ${result.status}: ${summarizeBody(result.bytes)}`,
          {},
        );
        await this.#backoff({ attempt, wait: computeBackoffMs(attempt), call, failure });
        continue;
      }

      // Client errors are final; anything but 200 (fetch follows redirects) is not a report.
      if (result.status >= 400) {
        throw mapClientError({ ...result, feature: spec.feature });
      }
      if (result.status !== 200) {
        throw new ToolError(
          'INVALID_RESPONSE',
          `The Toggl API returned unexpected HTTP status ${result.status}.`,
          {},
        );
      }
      return result;
    }
  }

  /** Waits before the next attempt, or throws the failure when attempts or time run out. */
  async #backoff(params: {
    attempt: number;
    wait: number;
    call: CallContext;
    failure: ToolError;
  }): Promise<void> {
    if (params.attempt >= MAX_ATTEMPTS || Date.now() + params.wait > params.call.deadline) {
      throw params.failure;
    }
    await sleepAbortable(params.wait, params.call.signal);
  }

  /** Performs one paced HTTP attempt, classifying aborts as CANCELLED or TIMEOUT. */
  async #attempt(spec: RequestSpec): Promise<HttpResult> {
    // Resolve auth first so a missing token is CONFIG_ERROR rather than a network failure.
    const authorization = this.#buildAuthorization();

    return await this.#schedule(spec.call.signal, async () => {
      const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
      try {
        const response = await this.#fetch(spec.url, {
          method: spec.method,
          headers: { Authorization: authorization, 'Content-Type': 'application/json' },
          body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
          signal: AbortSignal.any([timeout, spec.call.signal]),
        });

        // The download is part of the attempt: aborts during it must classify the same way.
        const bytes = await readBodyCapped(response, this.#maxResponseBytes);
        return { status: response.status, headers: response.headers, bytes };
      } catch (err) {
        if (err instanceof ToolError) {
          throw err;
        }
        if (spec.call.signal.aborted) {
          throw createCancelledError();
        }
        if (timeout.aborted) {
          throw new ToolError(
            'TIMEOUT',
            `The Toggl API did not respond within ${this.#requestTimeoutMs} ms. Large exports can be slow; consider a smaller date range or a higher TOGGL_REQUEST_TIMEOUT_MS.`,
            {},
          );
        }

        // fetch rejects with TypeError for DNS, connection and TLS failures.
        if (err instanceof TypeError) {
          throw new ToolError('NETWORK_ERROR', `Could not reach the Toggl API: ${err.message}`, {});
        }
        throw err;
      }
    });
  }

  /** Serialises requests with a minimum start interval so concurrent calls never self-inflict 429s. */
  async #schedule<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    // Take a slot at the tail of the queue.
    const previous = this.#queueTail;
    let release = (): void => {};
    this.#queueTail = new Promise((resolve) => {
      release = resolve;
    });

    // Wait for the predecessor and the pacing interval; a cancelled call frees its slot at once.
    try {
      await previous;
      if (signal.aborted) {
        throw createCancelledError();
      }
      const wait = this.#lastRequestStart + this.#minRequestIntervalMs - Date.now();
      if (wait > 0) {
        await sleepAbortable(wait, signal);
      }
      this.#lastRequestStart = Date.now();
      return await run();
    } finally {
      release();
    }
  }

  /** Builds the basic-auth header, failing with setup guidance when no token is configured. */
  #buildAuthorization(): string {
    if (this.#apiToken === undefined) {
      throw new ToolError('CONFIG_ERROR', 'No Toggl API token is configured.', {
        tip: 'Set TOGGL_API_KEY (or the aliases TOGGL_API_TOKEN / TOGGL_TOKEN) in the MCP server environment. Find your token at https://track.toggl.com/profile.',
      });
    }
    return `Basic ${Buffer.from(`${this.#apiToken}:api_token`).toString('base64')}`;
  }
}

/** Exponential backoff with jitter for transient failures. */
function computeBackoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

/** Parses a successful response body as JSON, reporting garbage as INVALID_RESPONSE. */
function parseJsonBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      throw err;
    }
    throw new ToolError(
      'INVALID_RESPONSE',
      `The Toggl API returned a body that is not valid JSON: ${summarizeBody(bytes)}`,
      {},
    );
  }
}
