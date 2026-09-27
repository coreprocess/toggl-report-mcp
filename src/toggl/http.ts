/**
 * Low-level HTTP helpers for the Toggl client: abort-aware waiting, Retry-After parsing,
 * size-capped body reading, status-to-ToolError mapping and export file validation.
 */

import { Buffer } from 'node:buffer';
import { ToolError } from '#errors/errors';

/** File formats Toggl can export; each is validated by its magic bytes before hitting disk. */
export type FileFormat = 'pdf' | 'csv' | 'xlsx';

/** Error reported when the calling client cancels the tool call. */
export function createCancelledError(): ToolError {
  return new ToolError('CANCELLED', 'The tool call was cancelled.', {});
}

/** Waits for the given time, rejecting with CANCELLED as soon as the signal aborts. */
export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(createCancelledError());
  }
  return new Promise((resolve, reject) => {
    // Whichever fires first (timer or abort) detaches the other.
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(createCancelledError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Settles with the promise, but rejects early with CANCELLED when the signal aborts. Lets
 * callers sharing one in-flight request detach individually without cancelling the others.
 */
export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(createCancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(createCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Parses Retry-After in both RFC forms (delta-seconds and HTTP-date) into milliseconds. */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Reads the whole body, aborting the download once it exceeds the byte cap. */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = new ToolError(
    'RESPONSE_TOO_LARGE',
    `The Toggl API response exceeds the configured limit of ${Math.round(maxBytes / (1024 * 1024))} MB. Narrow the date range or raise TOGGL_MAX_EXPORT_MB.`,
    {},
  );

  // A declared oversize length fails before downloading anything.
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw tooLarge;
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }

  // Stream chunk by chunk so an undeclared oversize body is cut off early.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Condenses a response body into a short single-line excerpt for error messages. */
export function summarizeBody(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString('utf8').replace(/\s+/g, ' ').trim();
  if (text === '') {
    return '(empty response body)';
  }
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Maps a non-retryable 4xx response to an actionable ToolError. */
export function mapClientError(params: {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  feature: string;
}): ToolError {
  const { status, headers, bytes, feature } = params;

  // 402 with quota headers is quota exhaustion; without them it is paid-feature gating.
  if (status === 402) {
    if (headers.has('x-toggl-quota-remaining') || headers.has('x-toggl-quota-resets-in')) {
      const resetsIn = Number(headers.get('x-toggl-quota-resets-in') ?? Number.NaN);
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

  // Toggl documents 403 for failed authentication, so both statuses mean auth trouble.
  if (status === 401 || status === 403) {
    return new ToolError(
      'AUTH_FAILED',
      `Toggl rejected the request (HTTP ${status}). This usually means the API token is wrong (check TOGGL_API_KEY for typos or stray whitespace) or the token has no access to the requested workspace.`,
      {},
    );
  }
  if (status === 404) {
    return new ToolError(
      'NOT_FOUND',
      `The Toggl API returned HTTP 404: the workspace or resource does not exist or is not accessible with this token. ${summarizeBody(bytes)}`,
      {},
    );
  }
  return new ToolError(
    'INVALID_REQUEST',
    `The Toggl API rejected the request (HTTP ${status}): ${summarizeBody(bytes)}`,
    {},
  );
}

/** Rejects bodies that are not a genuine file of the requested format (e.g. an error page). */
export function validateFileBytes(bytes: Uint8Array, format: FileFormat): void {
  // An empty body is never a report.
  if (bytes.length === 0) {
    throw new ToolError('INVALID_RESPONSE', 'The Toggl API returned an empty response body.', {});
  }

  // Each format has a recognisable signature; CSV is checked negatively (no JSON/HTML).
  const buffer = Buffer.from(bytes);
  switch (format) {
    case 'pdf':
      if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        throw new ToolError(
          'INVALID_RESPONSE',
          `The Toggl API response is not a PDF document: ${summarizeBody(bytes)}`,
          {},
        );
      }
      return;
    case 'xlsx':
      if (!buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        throw new ToolError(
          'INVALID_RESPONSE',
          `The Toggl API response is not an XLSX workbook: ${summarizeBody(bytes)}`,
          {},
        );
      }
      return;
    case 'csv': {
      const head = buffer.toString('utf8', 0, Math.min(buffer.length, 256)).trimStart();
      if (head.startsWith('{') || head.startsWith('[') || head.startsWith('<')) {
        throw new ToolError(
          'INVALID_RESPONSE',
          `The Toggl API response does not look like CSV: ${summarizeBody(bytes)}`,
          {},
        );
      }
      return;
    }
    default:
      throw new Error(`Unhandled file format: ${String(format satisfies never)}`);
  }
}
