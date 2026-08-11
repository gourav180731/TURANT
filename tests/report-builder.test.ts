import { describe, expect, it, vi } from 'vitest';
import { buildAlertReport, pushCompletionReport } from '../src/pipeline/report-builder.js';
import { traceStore } from '../src/tracing/trace-store.js';

describe('report builder (module 12 EWS completion report)', () => {
  it('builds a real AlertReport from pipeline counts (no fabrication)', async () => {
    const id = `report-${Date.now()}`;
    await traceStore.mark(id, 't0', 'cap.ingest', 1000);

    const report = await buildAlertReport({
      alertId: 'alert-1',
      capIdentifier: id,
      targetedSubscriberCount: 10,
      submittedCount: 7,
      acceptedCount: 5,
      deliveredCount: 0,
      failedCount: 1,
      expiredMessageCount: 0,
      towerCount: 3,
    });

    expect(report.capIdentifier).toBe(id);
    expect(report.targetedSubscriberCount).toBe(10);
    expect(report.smsSubmittedCount).toBe(7);
    expect(report.successfulPushCount).toBe(7);
    expect(report.smsAcceptedCount).toBe(5);
    expect(report.failedCount).toBe(1);
    expect(report.deliveredCount).toBe(0);
    expect(report.towerCount).toBe(3);
    expect(report.completed).toBe(true);
    expect(report.processingStartedAt).toBe(new Date(1000).toISOString());
  });

  it('never reports submitted messages when awaiting SMPP credentials (submittedCount 0)', async () => {
    const id = `report-awaiting-${Date.now()}`;
    const report = await buildAlertReport({
      alertId: 'alert-2',
      capIdentifier: id,
      targetedSubscriberCount: 100,
      submittedCount: 0, // honest: nothing pushed to the SMSC
      acceptedCount: 0,
      deliveredCount: 0,
      failedCount: 0,
      expiredMessageCount: 0,
      towerCount: 5,
    });
    expect(report.smsSubmittedCount).toBe(0);
    expect(report.successfulPushCount).toBe(0);
    expect(report.smsAcceptedCount).toBe(0);
  });

  it('pushCompletionReport never throws into the pipeline when EWS is not configured', async () => {
    const push = vi.fn(async () => ({ ok: false, delivered: 'not-configured' }));
    const persist = vi.fn(async () => {});
    const report = await buildAlertReport({
      alertId: 'alert-3',
      capIdentifier: `report-push-${Date.now()}`,
      targetedSubscriberCount: 1,
      submittedCount: 0,
      acceptedCount: 0,
      deliveredCount: 0,
      failedCount: 0,
      expiredMessageCount: 0,
      towerCount: 1,
    });
    await expect(pushCompletionReport(report, { push, persist })).resolves.toBeUndefined();
    expect(push).toHaveBeenCalledWith(report, expect.objectContaining({ persistReport: persist }));
  });
});
