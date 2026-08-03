import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CapIngestionService } from '../src/modules/01-cap-ingestion/service.js';
import { traceStore } from '../src/tracing/trace-store.js';
import { computeDeliveryPercentiles, computeStageDeltas, type AlertTraceRecord } from '../src/types/trace.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cap.xml');
const fixtureXml = readFileSync(fixturePath, 'utf8');

const snap = async (id: string): Promise<AlertTraceRecord | undefined> => traceStore.snapshot(id);

describe('delivery percentiles (t0 → X% delivered)', () => {
  it('returns undefined without receipts', () => {
    expect(computeDeliveryPercentiles([])).toBeUndefined();
  });

  it('computes nearest-rank percentiles from DLR durations', () => {
    const p = computeDeliveryPercentiles([100, 200, 300, 400])!;
    expect(p.firstDeliveryMs).toBe(100);
    expect(p.p50Ms).toBe(200);
    expect(p.p90Ms).toBe(400); // ceil(0.9*4)-1 = index 3
    expect(p.p100Ms).toBe(400);
  });

  it('handles a single receipt', () => {
    const p = computeDeliveryPercentiles([777])!;
    expect(p.firstDeliveryMs).toBe(777);
    expect(p.p50Ms).toBe(777);
    expect(p.p90Ms).toBe(777);
  });
});

describe('inter-stage deltas', () => {
  it('computes deltas for stages that exist and skips missing ones', () => {
    const deltas = computeStageDeltas({
      points: {
        t0: { stage: 't0', label: 'ingest', epochMs: 1000 },
        t1: { stage: 't1', label: 'cell.match', epochMs: 2500 },
      },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ from: 't0', to: 't1', deltaMs: 1500 });
  });

  it('produces the full six-delta timeline when all stages are present', () => {
    const points = Object.fromEntries(
      ['t0', 't1', 't2', 't3', 't4', 't5'].map((stage, i) => [
        stage,
        { stage, label: stage, epochMs: 1000 + i * 100 },
      ]),
    ) as AlertTraceRecord['points'];
    const deltas = computeStageDeltas({ points });
    expect(deltas.map((d) => d.deltaMs)).toEqual([100, 100, 100, 100, 100, 500]);
  });
});

describe('AlertTraceStore', () => {
  it('records t0..t5 and recomputes the bottleneck deltas', async () => {
    const id = `trace-test-${Date.now()}`;
    await traceStore.mark(id, 't0', 'cap.ingest', 1000);
    await traceStore.mark(id, 't1', 'cell.match', 2500);
    await traceStore.mark(id, 't5', 'alert.expiry', 9000);

    const rec = await snap(id);
    expect(rec).toBeDefined();
    expect(rec!.points.t0!.epochMs).toBe(1000);
    expect(rec!.points.t5!.epochMs).toBe(9000);
    const deltas = computeStageDeltas(rec!);
    expect(deltas).toEqual([
      expect.objectContaining({ from: 't0', to: 't1', deltaMs: 1500 }),
      expect.objectContaining({ from: 't0', to: 't5', deltaMs: 8000 }),
    ]);
  });

  it('tracks expected recipients and percentile delivery relative to t0', async () => {
    const id = `trace-delivery-${Date.now()}`;
    await traceStore.mark(id, 't0', 'cap.ingest', 5000);
    await traceStore.setExpectedRecipients(id, 1000);
    await traceStore.recordDelivery(id, 5500); // +500ms
    await traceStore.recordDelivery(id, 5800); // +800ms
    await traceStore.recordDelivery(id, 5600); // +600ms

    const rec = await snap(id);
    expect(rec!.expectedRecipients).toBe(1000);
    expect(rec!.deliveredCount).toBe(3);
    expect(rec!.percentiles!.firstDeliveryMs).toBe(500);
    expect(rec!.percentiles!.p90Ms).toBe(800);
    expect(rec!.percentiles!.p100Ms).toBe(800);
  });

  it('lists most-recently-updated records first', async () => {
    const a = `trace-list-a-${Date.now()}`;
    const b = `trace-list-b-${Date.now()}`;
    await traceStore.mark(a, 't0', 'ingest', 1);
    await traceStore.mark(b, 't0', 'ingest', 2);
    await traceStore.mark(b, 't1', 'match', 3); // touch b last

    const list = await traceStore.list(50);
    const ids = list.map((r) => r.capIdentifier);
    expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(a));
  });
});

describe('module 01 t0 hook', () => {
  it('marks t0 on the CAP identifier during ingest', async () => {
    const service = new CapIngestionService();
    const result = await service.ingest(fixtureXml);
    const rec = await snap(result.capIdentifier);
    expect(rec?.points.t0).toBeDefined();
    expect(rec?.points.t0?.label).toBe('cap.ingest');
    expect(rec?.points.t0?.epochMs).toBeLessThanOrEqual(Date.now());
  });
});
