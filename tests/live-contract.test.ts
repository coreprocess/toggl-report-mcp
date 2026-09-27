import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { countCsvRows } from '../src/exports.js';
import { TogglClient } from '../src/toggl-client.js';

/**
 * Live contract test against the real Toggl API. Opt-in: set
 * TOGGL_LIVE_TEST_TOKEN to a real API token (and optionally
 * TOGGL_LIVE_TEST_WORKSPACE_ID). Run with `npm run test:live`.
 *
 * This is the load-bearing check for the pagination question: research
 * concluded that file exports return the complete report (the page_size
 * fields in the docs are a docs-generation artifact), and this test verifies
 * it against a real account by comparing the CSV row count with the entry
 * count from the paginated JSON endpoint.
 */
const token = process.env.TOGGL_LIVE_TEST_TOKEN?.trim() ?? '';
const explicitWorkspaceId = process.env.TOGGL_LIVE_TEST_WORKSPACE_ID
  ? Number(process.env.TOGGL_LIVE_TEST_WORKSPACE_ID)
  : undefined;

const BASE_URL = 'https://api.track.toggl.com';
const JSON_PAGE_LIMIT = 4; // caps quota usage on busy accounts

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const end = new Date();
const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
const startDate = isoDate(start);
const endDate = isoDate(end);

function makeClient(): { client: TogglClient; exportDir: string } {
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toggl-mcp-live-'));
  const config: Config = {
    apiToken: token,
    exportDir,
    defaultWorkspaceId: explicitWorkspaceId,
    apiBaseUrl: BASE_URL,
    requestTimeoutMs: 120_000,
    maxExportBytes: 200 * 1024 * 1024,
  };
  return { client: new TogglClient(config), exportDir };
}

/** Counts entries via the paginated JSON endpoint (capped page count). */
async function countJsonEntries(
  workspaceId: number,
): Promise<{ count: number; capped: boolean }> {
  const auth = 'Basic ' + Buffer.from(`${token}:api_token`).toString('base64');
  let count = 0;
  let firstRowNumber: number | undefined;
  for (let page = 0; page < JSON_PAGE_LIMIT; page++) {
    const response = await fetch(
      `${BASE_URL}/reports/api/v3/workspace/${workspaceId}/search/time_entries`,
      {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_date: startDate,
          end_date: endDate,
          page_size: 50,
          ...(firstRowNumber !== undefined ? { first_row_number: firstRowNumber } : {}),
        }),
      },
    );
    expect(response.status).toBe(200);
    const entries = (await response.json()) as unknown[];
    count += entries.length;
    const next = response.headers.get('x-next-row-number');
    if (!next) return { count, capped: false };
    firstRowNumber = Number(next);
    // Stay well under the 1 req/s leaky bucket.
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  return { count, capped: true };
}

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!token)('live Toggl API contract', () => {
  it('lists workspaces', async () => {
    const { client, exportDir } = makeClient();
    cleanups.push(exportDir);
    const workspaces = await client.getWorkspaces();
    expect(workspaces.length).toBeGreaterThan(0);
    expect(workspaces[0]).toHaveProperty('id');
    expect(workspaces[0]).toHaveProperty('name');
  }, 60_000);

  it('detailed CSV export is complete (no 50-row pagination truncation)', async () => {
    const { client, exportDir } = makeClient();
    cleanups.push(exportDir);
    const workspaceId = await client.resolveWorkspaceId(explicitWorkspaceId, 'live test');

    const json = await countJsonEntries(workspaceId);
    const { bytes } = await client.exportReport({
      reportType: 'detailed',
      format: 'csv',
      workspaceId,
      body: { start_date: startDate, end_date: endDate },
    });
    const rowCount = countCsvRows(bytes);

    if (json.capped) {
      // More JSON pages remained; seeing more than one page's worth of CSV
      // rows already disproves 50-row truncation.
      expect(rowCount).toBeGreaterThanOrEqual(json.count);
      expect(rowCount).toBeGreaterThan(50);
    } else {
      expect(rowCount).toBe(json.count);
      if (json.count > 50) {
        expect(rowCount).toBeGreaterThan(50);
      } else {
        console.warn(
          `[live-contract] account has only ${json.count} entries in the last year; ` +
            'the >50-row truncation check is inconclusive on this account.',
        );
      }
    }
  }, 300_000);

  it('accepts a single-day date range', async () => {
    const { client, exportDir } = makeClient();
    cleanups.push(exportDir);
    const workspaceId = await client.resolveWorkspaceId(explicitWorkspaceId, 'live test');
    const { bytes } = await client.exportReport({
      reportType: 'detailed',
      format: 'csv',
      workspaceId,
      body: { start_date: endDate, end_date: endDate },
    });
    // Any non-error response (even a header-only CSV) proves single-day
    // ranges are accepted.
    expect(countCsvRows(bytes)).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
