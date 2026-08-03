import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCapXml } from '../src/modules/01-cap-ingestion/cap-parser.js';
import { chunkBatch, orchestrateAlertPipeline, splitBatches } from '../src/modules/13-parallel-processing/orchestrator.js';
import { loadConfig } from '../src/config/env.js';
import type { WorkerJob } from '../src/modules/13-parallel-processing/types.js';
import { SmppClient } from '../src/modules/07-smpp-integration/smpp-client.js';
import { resetSmppSessionForTests, setSmppClientFactoryForTests } from '../src/modules/07-smpp-integration/smpp-session.js';
import type { SmsMessage } from '../src/types/sms.js';

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
    const executor = vi.fn(async (job: WorkerJob) => {
      const batch = job.batch;
      return {
        total: batch.length,
        accepted: batch.length,
        rejected: 0,
        failed: 0,
        retried: 0,
        gaveUpExpired: 0,
        exhaustedRetries: 0,
        awaitingCredentials: false,
        results: batch.map((m) => ({ messageId: m, msisdn: m, outcome: 'accepted' as const })),
      };
    });

    const cfg = loadConfig();
    const result = await orchestrateAlertPipeline({ alert, content: 'storm', msisdns, executor, cfg });

    expect(result.capIdentifier).toBe(alert.identifier);
    expect(result.aggregate.total).toBe(10);
    expect(result.aggregate.accepted).toBe(10);
    expect(executor).toHaveBeenCalled();
  });

  it('reports awaitingCredentials when the executor sees no SMPP config', async () => {
    const executor = vi.fn(async (job: WorkerJob) => ({
      total: job.batch.length,
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

describe('module 13 — real CAP expiry threaded into the retry path', () => {
  afterEach(() => {
    resetSmppSessionForTests();
    vi.useRealTimers();
  });

  it('halts retries on the real CAP expiry through the submission path', async () => {
    vi.useFakeTimers();

    const cfg = {
      ...loadConfig(),
      SMPP_HOST: 'smpp.sandbox.cdot.in',
      SMPP_SYSTEM_ID: 'turant',
      DELIVERY_STRATEGY: 'retry',
      DELIVERY_RETRY_MAX: 3,
      DELIVERY_RETRY_INTERVAL_MS: 2000,
      PARALLEL_EXECUTION_MODE: 'inline',
    };

    // Every submit_sm is rejected, so the retry queue is forced to run rounds.
    const fakeClient = new SmppClient(cfg);
    fakeClient.isConfigured = () => true;
    fakeClient.submitBatch = async (messages: readonly SmsMessage[]) =>
      messages.map((m) => ({
        messageId: m.messageId,
        msisdn: m.msisdn,
        outcome: 'rejected' as const,
        errorCode: 0x400,
        errorText: 'throttled',
      }));
    setSmppClientFactoryForTests(() => fakeClient);

    // Real CAP alert whose expires is 100ms in the (faked) future.
    const expiry = new Date(Date.now() + 100);
    const alert = parseCapXml(`<?xml version="1.0"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
      <identifier>CDOT-EXP-${Date.now()}</identifier><sender>ews@cdot.in</sender>
      <sent>2026-08-04T06:00:00+05:30</sent><status>Actual</status><msgType>Alert</msgType>
      <scope>Public</scope><code>x</code>
      <info><language>en-IN</language><category>Met</category><event>Storm</event>
      <urgency>Immediate</urgency><severity>Severe</severity><certainty>Likely</certainty>
      <expires>${expiry.toISOString()}</expires><area><areaDesc>test</areaDesc></area></info>
    </alert>`);

    const promise = orchestrateAlertPipeline({
      alert,
      content: 'Storm warning',
      msisdns: ['9190000001', '9190000002'],
      cfg,
    });

    // Initial submit rejects; the retry backoff (2000ms) runs past the real
    // expiry (now+100ms) — the retry must halt on the alert's expiry.
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result.aggregate.retried).toBeGreaterThan(0); // the initial round did retry
    expect(result.aggregate.gaveUpExpired).toBeGreaterThan(0); // ...then halted on expiry
    expect(result.aggregate.exhaustedRetries).toBe(0); // not a retry-exhaustion outcome
  });
});
