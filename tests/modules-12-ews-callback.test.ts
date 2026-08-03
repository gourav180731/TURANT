import { describe, expect, it, vi } from 'vitest';
import { latencySectionForReport, pushReportToEws } from '../src/modules/12-ews-callback/ews-callback.js';
import { traceStore } from '../src/tracing/trace-store.js';
import type { AlertReport } from '../src/types/report.js';

const makeReport = (capIdentifier: string): AlertReport => ({
  alertId: 'alert-1',
  capIdentifier,
  processingStartedAt: new Date(0).toISOString(),
  processingEndedAt: new Date(1).toISOString(),
  targetedSubscriberCount: 10,
  smsSubmittedCount: 10,
  smsAcceptedCount: 10,
  deliveredCount: 0,
  failedCount: 0,
  expiredMessageCount: 0,
  successfulPushCount: 10,
  towerCount: 2,
  completed: false,
});

describe('module 12 — EWS callback', () => {
  it('reports not-configured when no URL is set (no fabricated delivery)', async () => {
    const cfg = { EWS_CALLBACK_URL: undefined, EWS_CALLBACK_TIMEOUT_MS: 5000 } as never;
    const fetchMock = vi.fn();
    const result = await pushReportToEws(makeReport('x'), { cfg, fetch: fetchMock });
    expect(result).toMatchObject({ ok: false, delivered: 'not-configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to DB persistence when not configured and a persister exists', async () => {
    const cfg = { EWS_CALLBACK_URL: undefined, EWS_CALLBACK_TIMEOUT_MS: 5000 } as never;
    const persist = vi.fn(async () => {});
    const result = await pushReportToEws(makeReport('x'), { cfg, persistReport: persist });
    expect(result).toMatchObject({ ok: true, delivered: 'db-fallback' });
    expect(persist).toHaveBeenCalled();
  });

  it('POSTs the report to the configured URL and reports HTTP success', async () => {
    const cfg = { EWS_CALLBACK_URL: 'https://ews.example.in/alert', EWS_CALLBACK_TOKEN: 'tok', EWS_CALLBACK_TIMEOUT_MS: 5000 } as never;
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }));
    const report = makeReport('cdot-1');
    const result = await pushReportToEws(report, { cfg, fetch: fetchMock });

    expect(result).toMatchObject({ ok: true, delivered: 'http', statusCode: 202 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ews.example.in/alert',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(report) }),
    );
  });

  it('reports rejection when the EWS returns a non-2xx status', async () => {
    const cfg = { EWS_CALLBACK_URL: 'https://ews.example.in/alert', EWS_CALLBACK_TIMEOUT_MS: 5000 } as never;
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
    const result = await pushReportToEws(makeReport('x'), { cfg, fetch: fetchMock });
    expect(result).toMatchObject({ ok: false, delivered: 'http', statusCode: 401 });
  });

  it('falls back to DB persistence when the HTTP call throws', async () => {
    const cfg = { EWS_CALLBACK_URL: 'https://ews.example.in/alert', EWS_CALLBACK_TIMEOUT_MS: 5000 } as never;
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const persist = vi.fn(async () => {});
    const result = await pushReportToEws(makeReport('x'), { cfg, fetch: fetchMock, persistReport: persist });
    expect(result).toMatchObject({ ok: true, delivered: 'db-fallback' });
    expect(persist).toHaveBeenCalled();
  });

  it('derives latencyMs from the shared trace', async () => {
    const id = `ews-latency-${Date.now()}`;
    await traceStore.mark(id, 't0', 'cap.ingest', 1000);
    await traceStore.recordDelivery(id, 1500); // +500ms
    await traceStore.recordDelivery(id, 2000); // +1000ms

    const latency = await latencySectionForReport(id);
    expect(latency?.t0ToFirstDeliveryMs).toBe(500);
    expect(latency?.t0ToP100Ms).toBe(1000);
  });
});
