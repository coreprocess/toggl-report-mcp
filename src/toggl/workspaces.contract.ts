/**
 * Workspace resolution for report calls: an explicit workspace_id argument wins, then the
 * configured default, then automatic discovery — a sole workspace on the account resolves
 * silently, while multiple workspaces produce a WORKSPACE_REQUIRED error listing them so the
 * MCP client can retry with workspace_id. Discovery is cached with a TTL and deduplicated,
 * because /me/* calls draw from a strict hourly quota.
 */

import { ToolError } from '#errors/errors';
import type { CallContext, TogglClient, Workspace } from './client.contract.ts';
import { raceWithAbort } from './http.ts';

/** Workspace membership can change under a long-lived server, so the cache expires. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Recovery hint attached to workspace errors. */
const WORKSPACE_TIP =
  'Pass workspace_id explicitly, or set TOGGL_DEFAULT_WORKSPACE_ID in your MCP server environment.';

/** Resolves the workspace for a call, discovering the account's workspaces when needed. */
export class WorkspaceResolver {
  readonly #client: TogglClient;

  /** Workspace configured via environment; undefined when not set. */
  readonly #defaultId: number | undefined;

  /** Last non-empty discovery result with its fetch time. */
  #cache: { fetchedAt: number; workspaces: Workspace[] } | undefined;

  /** Discovery currently in flight, shared by concurrent callers. */
  #inflight: Promise<Workspace[]> | undefined;

  constructor(params: { client: TogglClient; defaultWorkspaceId: number | undefined }) {
    this.#client = params.client;
    this.#defaultId = params.defaultWorkspaceId;
  }

  /** Picks the workspace for one call: argument, configured default, or sole workspace. */
  async resolve(params: {
    provided: number | undefined;
    action: string;
    call: CallContext;
  }): Promise<number> {
    // Explicit argument and configured default need no discovery.
    if (params.provided !== undefined) {
      return params.provided;
    }
    if (this.#defaultId !== undefined) {
      return this.#defaultId;
    }

    // A sole workspace is unambiguous; anything else needs the caller to decide.
    const workspaces = await this.#discover(params.call);
    const sole = workspaces[0];
    if (workspaces.length === 1 && sole !== undefined) {
      return sole.id;
    }
    if (workspaces.length === 0) {
      throw new ToolError(
        'WORKSPACE_REQUIRED',
        `Workspace ID required for ${params.action}, but no Toggl workspaces are accessible with this API token.`,
        { tip: WORKSPACE_TIP, available_workspaces: [] },
      );
    }
    const listing = workspaces.map((workspace) => `${workspace.id} (${workspace.name})`).join(', ');
    throw new ToolError(
      'WORKSPACE_REQUIRED',
      `Workspace ID required for ${params.action}. Retry with workspace_id set to one of: ${listing}. Alternatively configure the TOGGL_DEFAULT_WORKSPACE_ID environment variable.`,
      { tip: WORKSPACE_TIP, available_workspaces: workspaces },
    );
  }

  /**
   * Adds the accessible workspaces to an AUTH_FAILED error, since a wrong workspace_id is a
   * common cause. The lookup goes through the discovery cache, so it costs a /me request only
   * while no fresh list is cached. Other errors pass through unchanged.
   */
  async enrichAuthError(params: { error: unknown; call: CallContext }): Promise<unknown> {
    const { error } = params;
    if (!(error instanceof ToolError && error.code === 'AUTH_FAILED')) {
      return error;
    }

    // The enrichment is best-effort: a failing lookup keeps the original auth error, but a
    // cancellation must still surface as such.
    let workspaces: Workspace[] | undefined;
    try {
      workspaces = await this.#discover(params.call);
    } catch (lookupError) {
      if (!(lookupError instanceof ToolError) || lookupError.code === 'CANCELLED') {
        throw lookupError;
      }
    }
    if (workspaces === undefined || workspaces.length === 0) {
      return error;
    }
    return new ToolError(error.code, error.message, {
      ...error.extra,
      available_workspaces: workspaces,
    });
  }

  /** Returns cached workspaces or joins/starts a shared discovery request. */
  async #discover(call: CallContext): Promise<Workspace[]> {
    // Fresh cache needs no request.
    const cached = this.#readCache();
    if (cached !== undefined) {
      return cached;
    }

    // The shared request runs detached from any caller's signal so one cancellation cannot
    // cancel the others; each caller races it against its own signal instead.
    if (this.#inflight === undefined) {
      const detached = { signal: new AbortController().signal, deadline: call.deadline };
      const inflight = this.#fetch(detached).finally(() => {
        this.#inflight = undefined;
      });

      // Every joiner may detach; keep the shared rejection from going unhandled.
      inflight.catch(() => undefined);
      this.#inflight = inflight;
    }
    return await raceWithAbort(this.#inflight, call.signal);
  }

  /** Fetches workspaces, caching only non-empty lists (an empty one may be a transient glitch). */
  async #fetch(call: CallContext): Promise<Workspace[]> {
    const workspaces = await this.#client.listWorkspaces(call);
    if (workspaces.length > 0) {
      this.#cache = { fetchedAt: Date.now(), workspaces };
    }
    return workspaces;
  }

  /** Returns the cached list while it is fresh. */
  #readCache(): Workspace[] | undefined {
    if (this.#cache !== undefined && Date.now() - this.#cache.fetchedAt < CACHE_TTL_MS) {
      return this.#cache.workspaces;
    }
    return undefined;
  }
}
