import type { TelecomSubscriber } from '../entities/telecom-subscriber.js';

/**
 * Subscriber repository contract for the telecom simulation (modules 03/04).
 *
 * Two adapters ship with TURANT:
 *
 *   - InMemorySubscriberRepository : the sim's in-process store (tests / local
 *     dev, no database needed).
 *   - PostgresSubscriberRepository : real PostgreSQL tables seeded by the sim
 *     seeder (the 1K → 300M path), with configurable table/column names so it
 *     can later point at the real C-DOT subscriber schema without code changes.
 *
 * The real C-DOT repository that modules 03/04 will eventually use must
 * implement the same interface; nothing else in the pipeline changes.
 */

/** The shape the matcher actually needs per matched cell. */
export interface SubscriberRow {
  imsi: string;
  msisdn: string;
  cellId: string;
  towerId?: string;
  technology?: string;
  status?: string;
  lastSeen?: Date;
}

export interface FindByCellIdsOptions {
  /** Safety cap per lookup. */
  limit?: number;
}

export interface SubscriberRepository {
  /** Stable name for logs/audit, e.g. "telecom-sim:memory" | "telecom-sim:postgres". */
  readonly name: string;
  /** Total subscribers currently stored (seeding idempotency/resume). */
  count(): Promise<number>;
  /** Insert or refresh a batch of subscribers (idempotent by IMSI). */
  upsertSubscribers(rows: readonly TelecomSubscriber[]): Promise<number>;
  /** Subscribers currently attached to any of the given cell ids. */
  findByCellIds(cellIds: readonly string[], options?: FindByCellIdsOptions): Promise<SubscriberRow[]>;
  /** Full records for a list of MSISDNs (module 04 lookup path). */
  findByMsisdns(msisdns: readonly string[], options?: FindByCellIdsOptions): Promise<TelecomSubscriber[]>;
}

/** Thrown by the repository factory when the real C-DOT store is not configured. */
export class SubscriberRepositoryNotConfiguredError extends Error {
  constructor() {
    super('Real C-DOT Subscriber Repository Not Configured');
    this.name = 'SubscriberRepositoryNotConfiguredError';
  }
}

/** Base class for repository I/O failures. */
export class SubscriberRepositoryError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'SubscriberRepositoryError';
  }
}
