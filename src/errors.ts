/**
 * Error thrown by tool implementations. It is converted into an MCP tool
 * result with `isError: true` whose text content carries the JSON payload
 * (`code`, `message`, plus extra fields such as `tip` or
 * `available_workspaces`), mirroring the error body shape used by
 * verygoodplugins/mcp-toggl.
 */
export class ToolError extends Error {
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.extra = extra;
  }

  toPayload(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.extra };
  }
}
