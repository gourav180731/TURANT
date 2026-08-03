import { getLogger } from '../../utils/logger.js';

const logger = getLogger();

/**
 * Priority flagging — requirement #9.
 *
 * Real mapping from TURANT's internal priority concept to the SMPP
 * `priority_flag` values (0 = lowest … 3 = highest). Every early-warning alert
 * resolves to the highest value (3) so the SMSC queues it ahead of normal
 * traffic. This is an exported function, not a comment: module 07's
 * submit_sm construction calls `smsPriorityFlag()` directly.
 */

export const SMPP_PRIORITY_FLAG_MIN = 0 as const;
export const SMPP_PRIORITY_FLAG_MAX = 3 as const;

export type SmppPriorityFlag = 0 | 1 | 2 | 3;

/** TURANT-internal priority taxonomy. */
export type TurantPriority = 'low' | 'normal' | 'high' | 'critical' | 'early-warning';

const TURANT_TO_SMPP: Record<TurantPriority, SmppPriorityFlag> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
  'early-warning': 3,
};

/** Resolve a TURANT priority to an SMPP priority_flag (0-3). */
export function priorityToSmppFlag(priority: TurantPriority): SmppPriorityFlag {
  const flag = TURANT_TO_SMPP[priority];
  if (flag === undefined) {
    throw new RangeError(`Unknown TURANT priority "${priority}"`);
  }
  return flag;
}

/**
 * The flag for an early-warning SMS — always the maximum (3). Early-warning is
 * the only category TURANT disseminates, so this is the value every
 * submit_sm carries.
 */
export function earlyWarningPriorityFlag(): 3 {
  return 3;
}

/** Convenience: flag for a boolean early-warning marker (used by callers). */
export function smsPriorityFlag(isEarlyWarning: boolean): SmppPriorityFlag {
  if (isEarlyWarning) return earlyWarningPriorityFlag();
  logger.warn('smsPriorityFlag called with isEarlyWarning=false — TURANT only disseminates early warnings');
  return SMPP_PRIORITY_FLAG_MIN;
}
