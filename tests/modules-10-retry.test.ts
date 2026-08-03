import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpiryGuard } from '../src/modules/06-expiry-control/expiry-guard.js';
import { runRetryQueue } from '../src/modules/10-delivery-strategy/retry-queue.js';
import type { SubmissionResult } from '../src/types/sms.js';

const accepted = (msisdn: string): SubmissionResult => ({ messageId: msisdn, msisdn, outcome: 'accepted' });
const rejected = (msisdn: string): SubmissionResult => ({ messageId: msisdn, msisdn, outcome: 'rejected', errorCode: 0x400, errorText: 'throttled' });

const retryPolicy = (max: number) => ({ strategy: 'retry' as const, retryMax: max, retryIntervalMs: 2000 });
const singleAttemptPolicy = { strategy: 'single-attempt' as const, retryMax: 3, retryIntervalMs: 2000 };

describe('module 10 — retry queue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does nothing for an empty failure list', async () => {
    const guard = new ExpiryGuard({ expiresAt: null });
    const result = await runRetryQueue([], { policy: retryPolicy(3), guard, submit: async () => [] });
    expect(result).toMatchObject({ retried: 0, exhaustedRetries: 0, finalFailures: [] });
  });

  it('never retries in single-attempt mode', async () => {
    const guard = new ExpiryGuard({ expiresAt: null });
    const submit = vi.fn(async (batch: readonly string[]) => batch.map(rejected));
    const result = await runRetryQueue(['a', 'b'], { policy: singleAttemptPolicy, guard, submit });
    expect(submit).not.toHaveBeenCalled();
    expect(result.finalFailures).toEqual(['a', 'b']);
  });

  it('retries failed messages until they pass, up to the max', async () => {
    const guard = new ExpiryGuard({ expiresAt: null });
    let attempt = 0;
    const submit = vi.fn(async (batch: readonly string[]) => {
      attempt += 1;
      return batch.map((m) => (attempt >= 3 ? accepted(m) : rejected(m)));
    });

    const promise = runRetryQueue(['a', 'b'], { policy: retryPolicy(3), guard, submit });
    await vi.advanceTimersByTimeAsync(6000); // two intervals between rounds 2 and 3
    const result = await promise;

    expect(submit).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ retried: 6, exhaustedRetries: 0, finalFailures: [] });
  });

  it('stops early once everything is accepted', async () => {
    const guard = new ExpiryGuard({ expiresAt: null });
    let attempt = 0;
    const submit = vi.fn(async (batch: readonly string[]) => {
      attempt += 1;
      return attempt === 1 ? batch.map(rejected) : batch.map(accepted);
    });

    const promise = runRetryQueue(['x'], { policy: retryPolicy(5), guard, submit });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(submit).toHaveBeenCalledTimes(2);
    expect(result.exhaustedRetries).toBe(0);
  });

  it('halts when the alert expires before a retry round', async () => {
    let now = new Date('2026-08-04T03:29:00Z');
    const guard = new ExpiryGuard({
      expiresAt: new Date('2026-08-04T03:30:00Z'),
      now: () => now,
    });
    const submit = vi.fn(async (batch: readonly string[]) => batch.map(rejected));

    const promise = runRetryQueue(['a', 'b', 'c'], { policy: retryPolicy(3), guard, submit });
    now = new Date('2026-08-04T03:31:00Z'); // expiry passes before round 2's guard check
    const result = await promise;

    expect(submit).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ gaveUpExpired: 3, retried: 3, finalFailures: [] });
  });

  it('respects the configured interval between retry rounds', async () => {
    const guard = new ExpiryGuard({ expiresAt: null });
    const submit = vi.fn(async (batch: readonly string[]) => batch.map(rejected));

    const promise = runRetryQueue(['a'], { policy: retryPolicy(3), guard, submit });
    await vi.advanceTimersByTimeAsync(1500);
    expect(submit).toHaveBeenCalledTimes(1); // round 2 not yet due
    await vi.advanceTimersByTimeAsync(1000);
    expect(submit).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    expect(result.exhaustedRetries).toBe(1);
  });

  it('reports messages that exhaust all retries', async () => {
    const guard = new ExpiryGuard({ expiresAt: null });
    const submit = vi.fn(async (batch: readonly string[]) => batch.map(rejected));

    const promise = runRetryQueue(['a', 'b'], { policy: retryPolicy(3), guard, submit });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(submit).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(result).toMatchObject({ retried: 6, exhaustedRetries: 2, finalFailures: ['a', 'b'] });
  });
});
