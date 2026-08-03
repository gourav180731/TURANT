import { describe, expect, it } from 'vitest';
import { deduplicate, normalizeMsisdn } from '../src/modules/05-dedup/dedupe.js';
import { traceStore } from '../src/tracing/trace-store.js';

describe('module 05 — dedup', () => {
  it('keeps first-occurrence order and removes later duplicates', async () => {
    const input = ['+91-9876543210', '919876543210', '+919876543210', '91 987654 3210', '911234567890'];
    const result = await deduplicate(input);

    expect(result.originalCount).toBe(5);
    expect(result.deduplicated).toEqual(['+91-9876543210', '911234567890']);
    expect(result.removedCount).toBe(3);
  });

  it('normalizes +, spaces and dashes consistently', () => {
    expect(normalizeMsisdn('+91-98765 43210')).toBe('919876543210');
    expect(normalizeMsisdn('919876543210')).toBe('919876543210');
  });

  it('handles an empty list', async () => {
    const result = await deduplicate([]);
    expect(result.deduplicated).toEqual([]);
    expect(result.removedCount).toBe(0);
  });

  it('is a single pass over a large list', async () => {
    const big = Array.from({ length: 1_000_000 }, (_, i) => `+91-${(i % 500_000).toString().padStart(10, '0')}`);
    const result = await deduplicate(big);
    expect(result.deduplicated.length).toBe(500_000);
    expect(result.removedCount).toBe(500_000);
  });

  it('marks t2 and expected recipients on the shared trace when given a key', async () => {
    const id = `dedup-trace-${Date.now()}`;
    await deduplicate(['919876543210', '+919876543210'], id);

    const rec = await traceStore.snapshot(id);
    expect(rec?.expectedRecipients).toBe(1);
    expect(rec?.points.t2?.label).toBe('subscriber.match+dedup');
  });
});
