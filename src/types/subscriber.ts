/**
 * Subscriber model.
 *
 * The real subscriber database is provided by C-DOT (subscriber-to-tower /
 * subscriber-to-cell mapping). TURANT normalizes it into this shape and stores
 * it in the Redis prefetch layer (module 03) keyed by tower/cell id.
 */

export interface Subscriber {
  /** Subscriber number in E.164 international format, e.g. 919812345678. */
  msisdn: string;
  /** Tower/cell id the subscriber is currently attached to. */
  towerId: string;
  /** Optional: HLR/VLR-provided location fields from the source dataset. */
  locationAreaCode?: string;
  cellId?: string;
}
