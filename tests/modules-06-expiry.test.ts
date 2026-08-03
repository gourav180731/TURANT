import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCapXml } from '../src/modules/01-cap-ingestion/cap-parser.js';
import { ExpiryGuard, expiryGuardForAlert, isExpiredNow } from '../src/modules/06-expiry-control/expiry-guard.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cap.xml');
const fixtureXml = readFileSync(fixturePath, 'utf8');

describe('module 06 — expiry guard', () => {
  it('derives the real expires instant from a CAP alert', () => {
    const alert = parseCapXml(fixtureXml);
    // Fixture <expires> = 2026-08-04T09:00:00+05:30 == 03:30Z.
    expect(expiryGuardForAlert(alert).status().expiresAt?.toISOString()).toBe('2026-08-04T03:30:00.000Z');
  });

  it('allows submission before expiry', () => {
    const guard = new ExpiryGuard({
      expiresAt: new Date('2026-08-04T03:30:00.000Z'),
      now: () => new Date('2026-08-04T03:29:59.000Z'),
    });
    expect(guard.canSubmit()).toBe(true);
    expect(guard.status().reason).toBe('ok');
    expect(guard.remainingMs()).toBe(1000);
  });

  it('halts at the exact expiry instant', () => {
    const guard = new ExpiryGuard({
      expiresAt: new Date('2026-08-04T03:30:00.000Z'),
      now: () => new Date('2026-08-04T03:30:00.000Z'),
    });
    expect(guard.canSubmit()).toBe(false);
    expect(guard.status().reason).toBe('expired');
  });

  it('halts after expiry and reports negative remaining time', () => {
    const guard = new ExpiryGuard({
      expiresAt: new Date('2026-08-04T03:30:00.000Z'),
      now: () => new Date('2026-08-04T03:30:05.000Z'),
    });
    expect(guard.canSubmit()).toBe(false);
    expect(guard.status().remainingMs).toBeLessThan(0);
  });

  it('applies the lead margin to the halt point', () => {
    const guard = new ExpiryGuard({
      expiresAt: new Date('2026-08-04T03:30:00.000Z'),
      now: () => new Date('2026-08-04T03:29:30.000Z'),
      leadMarginMs: 60_000,
    });
    // 30s before expiry but margin says halt at 60s before.
    expect(guard.canSubmit()).toBe(false);
  });

  it('submits forever when no expiry is declared', () => {
    const guard = new ExpiryGuard({ expiresAt: null });
    expect(guard.canSubmit()).toBe(true);
    expect(guard.status().reason).toBe('no-expiry');
  });

  it('does not halt when EXPIRY_HALT_SUBMISSION is disabled', () => {
    const guard = new ExpiryGuard({
      expiresAt: new Date('2026-08-04T03:30:00.000Z'),
      now: () => new Date('2026-08-04T04:00:00.000Z'),
      haltEnabled: false,
    });
    expect(guard.canSubmit()).toBe(true);
    expect(guard.status().reason).toBe('halt-disabled');
  });

  it('isExpiredNow works as a one-shot check', () => {
    expect(isExpiredNow(new Date(Date.now() + 60_000))).toBe(false);
    expect(isExpiredNow(new Date(Date.now() - 1000))).toBe(true);
  });

  it('marks t5 = alert.expiry when halted', async () => {
    const { traceStore } = await import('../src/tracing/trace-store.js');
    const id = `expiry-trace-${Date.now()}`;
    const guard = new ExpiryGuard({
      expiresAt: new Date('2026-08-04T03:30:00.000Z'),
      now: () => new Date('2026-08-04T04:00:00.000Z'),
    });
    await guard.markExpiryTrace(id);
    const rec = await traceStore.snapshot(id);
    expect(rec?.points.t5?.label).toBe('alert.expiry');
  });
});
