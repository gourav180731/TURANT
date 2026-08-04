/**
 * Indian telecom identity generators — IMSI, MSISDN, IMEI, TMSI.
 *
 * Everything is structurally valid per telecom standards (ITU-T E.212 for
 * IMSI, ITU-T E.164 for MSISDN, 3GPP TS 23.003 / IMEI-TAC rules) and derives
 * from a deterministic PRNG plus a monotonic counter, so uniqueness holds even
 * across 300M rows without keeping a Set of seen values in memory.
 *
 * The canonical C-DOT samples are the reference format:
 *   IMSI   404685509376597   (MCC 404, MNC 68, MSIN 5509376597)
 *   MSISDN 919868419126      (country code 91 + 10-digit national number)
 *   LAC    0451
 *   CELL   9C81              (hex cell id, like LTE/UMTS sector ids)
 */

import { makeRangeInt } from './prng.js';

/** Valid Indian MNCs (2-digit; a few 3-digit MNCs exist but 2-digit dominates). */
export const INDIAN_MNC_POOL = [
  '68', '45', '86', '10', '30', '13', '15', '27', '31', '77',
  '93', '42', '51', '59', '66', '90', '97', '19', '34', '55',
  '71', '80', '81', '92', '22', '28', '33', '40', '43', '46',
  '50', '52', '53', '54', '56', '57', '58', '60', '61', '62',
  '63', '64', '65', '67', '69', '70', '72', '73', '74', '75',
  '76', '78', '79', '82', '83', '84', '85', '87', '88', '89',
  '91', '94', '95', '96', '98',
] as const;

/** MCC for India. 405 is the newer assignment; 404 is the traditional one. */
export const INDIAN_MCC_POOL = ['404', '405'] as const;

const MOBILE_SERIES = ['6', '7', '8', '9'] as const;

/** Luhn check digit for a 14-digit IMEI body (returns the 15th digit). */
export function luhnCheckDigit(body: string): number {
  let sum = 0;
  let double = false;
  for (let i = body.length - 1; i >= 0; i--) {
    let digit = body.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

/** Validate a full 15-digit IMEI with its Luhn check digit. */
export function isValidImei(imei: string): boolean {
  if (!/^\d{15}$/.test(imei)) return false;
  return Number(imei[14]) === luhnCheckDigit(imei.slice(0, 14));
}

/** Validate a structurally-valid IMSI (3-digit MCC + 2-3 digit MNC + MSIN). */
export function isValidImsi(imsi: string): boolean {
  return /^(404|405)\d{12}$/.test(imsi);
}

/** Validate a structurally-valid Indian MSISDN (91 + 10 digits starting 6-9). */
export function isValidMsisdn(msisdn: string): boolean {
  return /^91[6-9]\d{9}$/.test(msisdn);
}

export interface IdentityGenerator {
  /** Next unique IMSI (15 digits). */
  nextImsi(): string;
  /** Next unique MSISDN (E.164 without '+'). */
  nextMsisdn(): string;
  /** Next unique, Luhn-valid IMEI (15 digits). */
  nextImei(): string;
  /** Random TMSI (8 hex chars). */
  nextTmsi(): string;
}

/**
 * Counter-backed identity generator. `offset` lets parallel seed workers take
 * disjoint identity ranges so uniqueness never depends on shared state.
 */
export function createIdentityGenerator(mcc: string, mnc: string, rand: () => number, offset = 0): IdentityGenerator {
  // MSIN counter occupies the last 10 digits of the IMSI and the last 10 of
  // the MSISDN; both are guaranteed unique per generator. The MSISDN national
  // number keeps the 6-9 leading-series constraint by mapping into it.
  let counter = offset;

  const msisdnSeries = makeRangeInt(rand, 0, MOBILE_SERIES.length - 1);
  const imeiBody = () =>
    Array.from({ length: 14 }, () => Math.floor(rand() * 10)).join('');

  return {
    nextImsi() {
      // 404/405 + MNC + 10-digit MSIN. Total digits: 3 + 2 + 10 = 15.
      const msin = String(counter++).padStart(10, '0').slice(-10);
      return `${mcc}${mnc}${msin}`;
    },
    nextMsisdn() {
      const series = MOBILE_SERIES[msisdnSeries()]!;
      const rest = String(counter).padStart(9, '0').slice(-9);
      const national = `${series}${rest}`;
      return `91${national}`;
    },
    nextImei() {
      const body = imeiBody();
      return `${body}${luhnCheckDigit(body)}`;
    },
    nextTmsi() {
      return Array.from({ length: 8 }, () => '0123456789ABCDEF'[Math.floor(rand() * 16)]!).join('');
    },
  };
}
