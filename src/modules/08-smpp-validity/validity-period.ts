/**
 * SMSC-side validity enforcement — requirement #8.
 *
 * Converts a CAP `expires` Date into the SMPP 3.4 `validity_period` field so
 * the SMSC itself will not deliver an expired alert.
 *
 * SMPP 3.4 section 5.2.9 defines the time format:
 *
 *   YY MM DD hh mm ss t nn p
 *   2  2  2  2  2  2  1  2  1   = 16 characters
 *
 *   YY  - last two digits of the year
 *   MM  - month
 *   DD  - day
 *   hh  - hour (00-23)
 *   mm  - minute
 *   ss  - second
 *   t   - tenths of a second (0-9)
 *   nn  - difference in quarter hours between local time (the wall-clock
 *         encoded in the first 13 characters) and UTC (00-48; 00 = GMT)
 *   p   - 'R' for Relative time, '0' for Absolute time
 *
 * TURANT encodes absolute validity from the CAP expires timestamp. The wall
 * clock is rendered in the requested zone (default: the process local zone)
 * with the matching `nn` offset — or, when `timezoneOffsetMinutes: 0`, purely
 * in UTC with `nn = 00`, which is the least ambiguous form for SMSCs.
 */

const PAD2 = (n: number): string => String(Math.trunc(n)).padStart(2, '0');

export interface SmppValidityOptions {
  /**
   * Zone offset in minutes east of UTC used to render the wall clock.
   * Defaults to the process local offset (-date.getTimezoneOffset()).
   * Pass 0 to encode in UTC (nn = 00).
   */
  timezoneOffsetMinutes?: number;
  /** Seconds component is zeroed when true (common SMSC convention). */
  truncateSeconds?: boolean;
}

/** Quarter-hour difference (nn, 0-48) for a given UTC offset in minutes. */
export function smppQuarterHourOffset(offsetMinutes: number): number {
  const qh = Math.round(offsetMinutes / 15);
  if (qh < 0 || qh > 48) {
    throw new RangeError(`SMPP nn field requires offset in 0..48 quarter hours; got ${qh}`);
  }
  return qh;
}

/**
 * Encode an absolute validity_period (16 chars, trailing '0') from a Date.
 *
 * Hand-checked example: 2026-08-04T03:30:00.000Z with `timezoneOffsetMinutes: 0`
 * renders as "2608040330000000".
 */
export function toSmppValidityPeriod(date: Date, options: SmppValidityOptions = {}): string {
  const offsetMinutes = options.timezoneOffsetMinutes ?? -date.getTimezoneOffset();
  // Wall clock in the target zone = UTC instant shifted by the offset.
  const wall = new Date(date.getTime() + offsetMinutes * 60_000);

  const YY = PAD2(wall.getUTCFullYear() % 100);
  const MM = PAD2(wall.getUTCMonth() + 1);
  const DD = PAD2(wall.getUTCDate());
  const hh = PAD2(wall.getUTCHours());
  const mm = PAD2(wall.getUTCMinutes());
  const ss = PAD2(options.truncateSeconds ? 0 : wall.getUTCSeconds());
  const t = '0'; // tenths of a second
  const nn = PAD2(smppQuarterHourOffset(offsetMinutes));
  const p = '0'; // absolute time

  return `${YY}${MM}${DD}${hh}${mm}${ss}${t}${nn}${p}`;
}

/**
 * Relative validity_period (16 chars, trailing 'R') for a duration from the
 * moment of submission, per SMPP 3.4 (YY/MM/DD encode years/months/days of
 * duration when p = 'R').
 */
export function toSmppRelativeValidity(durationMs: number): string {
  if (durationMs < 0) throw new RangeError('durationMs must be >= 0');
  const totalSeconds = Math.floor(durationMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${PAD2(0)}${PAD2(0)}${PAD2(days)}${PAD2(hours)}${PAD2(minutes)}${PAD2(seconds)}0${PAD2(0)}R`;
}
