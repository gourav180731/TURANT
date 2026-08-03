import { describe, expect, it } from 'vitest';
import { toSmppRelativeValidity, toSmppValidityPeriod } from '../src/modules/08-smpp-validity/validity-period.js';

describe('module 08 — SMPP validity period', () => {
  it('encodes a UTC absolute instant with nn=00 (hand-verified)', () => {
    // 2026-08-04T03:30:00Z -> 2608040330000000
    const value = toSmppValidityPeriod(new Date('2026-08-04T03:30:00.000Z'), { timezoneOffsetMinutes: 0, truncateSeconds: true });
    expect(value).toBe('2608040330000000');
  });

  it('encodes a non-zero offset into the nn field', () => {
    // 2026-08-04T03:30:00Z rendered in +05:30 is 09:00 local; nn = 22 quarter-hours.
    const value = toSmppValidityPeriod(new Date('2026-08-04T03:30:00.000Z'), { timezoneOffsetMinutes: 330, truncateSeconds: true });
    expect(value).toBe('2608040900000220');
  });

  it('zeroes seconds when truncateSeconds is set', () => {
    const value = toSmppValidityPeriod(new Date('2026-08-04T03:30:59.000Z'), { timezoneOffsetMinutes: 0, truncateSeconds: true });
    expect(value).toMatch(/^2608040330[0-9]{6}$/);
    expect(value.slice(10, 12)).toBe('00');
  });

  it('keeps seconds otherwise', () => {
    const value = toSmppValidityPeriod(new Date('2026-08-04T03:30:59.000Z'), { timezoneOffsetMinutes: 0 });
    expect(value.slice(10, 12)).toBe('59');
  });

  it('rejects out-of-range quarter-hour offsets', () => {
    expect(() => toSmppValidityPeriod(new Date(), { timezoneOffsetMinutes: 13 * 60 })).toThrow(RangeError);
  });

  it('produces a relative validity ending in R', () => {
    const value = toSmppRelativeValidity(90 * 60_000); // 1h30m
    expect(value).toBe('000000013000000R');
    expect(value.endsWith('R')).toBe(true);
  });

  it('encodes days/hours/minutes/seconds from a duration', () => {
    const value = toSmppRelativeValidity((2 * 86_400 + 3 * 3600 + 4 * 60 + 5) * 1000);
    expect(value).toBe('000002030405000R');
  });

  it('rejects a negative duration', () => {
    expect(() => toSmppRelativeValidity(-1)).toThrow(RangeError);
  });
});
