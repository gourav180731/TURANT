import { describe, expect, it, vi } from 'vitest';
import { parseCapXml } from '../src/modules/01-cap-ingestion/cap-parser.js';
import { chunkBatch, orchestrateAlertPipeline, splitBatches } from '../src/modules/13-parallel-processing/orchestrator.js';
import { loadConfig } from '../src/config/env.js';

const alert = parseCapXml(
  `<?xml version="1.0"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
    <identifier>CDOT-TEST-${Date.now()}</identifier>
    <sender>ews@cdot.in</sender><sent>2026-08-04T06:00:00+05:30</sent>
    <status>Actual</status><msgType>Alert</msgType><scope>Public</scope><code>x</code>
    <info><language>en-IN</language><category>Met</category><event>Storm</event>
    <urgency>Immediate</urgency><severity>Severe</severity><certainty>Likely</certainty>
    <expires>2026-08-04T09:00:00+05:30</expires><area><areaDesc>test</areaDesc></area></info>
  </alert>`,
);

describe('module 13 — parallel processing', () => {
  it('returns a single batch for a list within one worker', () => {
    expect(splitBatches(['a', 'b'], 4, 500)).toEqual([['a', 'b']]);
  });

  it('splits a large list across workers and keeps the remainder in the last batch', () => {
    const msisdns = Array.from({ length: 10 }, (_, i) => `91${i}`);
    const batches = splitBatches(msisdns, 4, 3);
    expect(batches.length).toBe(4);
    expect(batches.map((b) => b.length)).toEqual([3, 3, 3, 1]);
  });

  it('does not exceed the max batch size', () => {
    const batches = splitBatches(Array.from({ length: 100 }, (_, i) => `9${i}`), 10, 30);
    expect(batches.every((b) => b.length <= 30)).toBe(true);
    expect(batches.reduce((n, b) => n + b.length, 0)).toBe(100);
  });

  it('handles the empty-list edge', () => {
    expect(splitBatches([], 4)).toEqual([]);
  });

  it('chunks a worker slice into SUBMIT_BATCH_SIZE pieces', () => {
    const chunks = chunkBatch(Array.from({ length: 7 }, (_, i) => `9${i}`), 3);
    expect(chunks.map((c) => c.length)).toEqual([3, 3, 1]);
  });

  it('runs each batch through the executor and merges the aggregate', async () => {
    const msisdns = Array.from({ length: 10 }, (_, i) => `9190${i}`);
    const executor = vi.fn(async (batch: readonly string[]) => ({
      total: batch.length,
      accepted: batch.length,
      rejected: 0,
      failed: 0,
      retried: 0,
      gaveUpExpired: 0,
      exhaustedRetries: 0,
      awaitingCredentials: false,
      results: batch.map((m) => ({ messageId: m, msisdn: m, outcome: 'accepted' as const })),
    }));

    const cfg = loadConfig();
    const result = await orchestrateAlertPipeline({ alert, content: 'storm', msisdns, executor, cfg });

    expect(result.capIdentifier).toBe(alert.identifier);
    expect(result.aggregate.total).toBe(10);
    expect(result.aggregate.accepted).toBe(10);
    expect(executor).toHaveBeenCalled();
  });

  it('reports awaitingCredentials when the executor sees no SMPP config', async () => {
    const executor = vi.fn(async (batch: readonly string[]) => ({
      total: batch.length,
      accepted: 0,
      rejected: 0,
      failed: 0,
      retried: 0,
      gaveUpExpired: 0,
      exhaustedRetries: 0,
      awaitingCredentials: true,
      results: [],
    }));

    const result = await orchestrateAlertPipeline({ alert, content: 'storm', msisdns: ['9190000'], executor });
    expect(result.aggregate.awaitingCredentials).toBe(true);
  });
});
