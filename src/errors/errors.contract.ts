/**
 * Expected, model-facing failures. Every layer below the tool boundary throws a ToolError
 * carrying a stable machine-readable code and an actionable message; the tool boundary turns
 * it into a structured `isError` result the calling model can recover from.
 */

/** Stable failure codes; a calling model can branch on these instead of parsing messages. */
export type ToolErrorCode =
  | 'AUTH_FAILED'
  | 'CANCELLED'
  | 'CONFIG_ERROR'
  | 'FEATURE_UNAVAILABLE'
  | 'FILE_WRITE_ERROR'
  | 'INVALID_FILENAME'
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'RESPONSE_TOO_LARGE'
  | 'TIMEOUT'
  | 'TOGGL_QUOTA_EXCEEDED'
  | 'UPSTREAM_ERROR'
  | 'WORKSPACE_REQUIRED';

/** An expected failure with a code, a human-readable message and optional structured hints. */
export class ToolError extends Error {
  /** Machine-readable failure category. */
  readonly code: ToolErrorCode;

  /** Additional fields merged into the error payload, e.g. a tip or available workspaces. */
  readonly extra: Record<string, unknown>;

  constructor(code: ToolErrorCode, message: string, extra: Record<string, unknown>) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.extra = extra;
  }

  /** Flattens the error into the JSON payload reported to the calling model. */
  toPayload(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.extra };
  }
}
