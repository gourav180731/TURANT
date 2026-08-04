import type { TelecomSubscriber } from '../entities/telecom-subscriber.js';
import {
  type FindByCellIdsOptions,
  type SubscriberRepository,
  type SubscriberRow,
} from './subscriber-repository.js';

/**
 * In-memory subscriber repository — the sim's zero-dependency store.
 *
 * Indexed by IMSI (identity) and by cell id (the matcher's hot path). Only the
 * fields modules 03/04 consume are retained per row; the seeder hands full
 * TelecomSubscriber records to `upsertSubscribers` and the memory keeps a
 * compact projection plus a full-record map for MSISDN lookups.
 */
export class InMemorySubscriberRepository implements SubscriberRepository {
  readonly name = 'telecom-sim:memory';

  private readonly byImsi = new Map<string, TelecomSubscriber>();
  private readonly byCellId = new Map<string, SubscriberRow[]>();
  private readonly byMsisdn = new Map<string, TelecomSubscriber>();

  async count(): Promise<number> {
    return this.byImsi.size;
  }

  async upsertSubscribers(rows: readonly TelecomSubscriber[]): Promise<number> {
    let inserted = 0;
    for (const row of rows) {
      const existing = this.byImsi.get(row.imsi);
      if (!existing) inserted += 1;
      this.byImsi.set(row.imsi, row);
      this.byMsisdn.set(row.msisdn, row);

      const list = this.byCellId.get(row.cellId) ?? [];
      const idx = list.findIndex((r) => r.imsi === row.imsi);
      const projection: SubscriberRow = {
        imsi: row.imsi,
        msisdn: row.msisdn,
        cellId: row.cellId,
        towerId: row.towerId,
        technology: row.technology,
        status: row.status,
        lastSeen: row.lastSeen,
      };
      if (idx >= 0) list[idx] = projection;
      else list.push(projection);
      this.byCellId.set(row.cellId, list);
    }
    return inserted;
  }

  async findByCellIds(cellIds: readonly string[], options: FindByCellIdsOptions = {}): Promise<SubscriberRow[]> {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const out: SubscriberRow[] = [];
    for (const cellId of cellIds) {
      const rows = this.byCellId.get(cellId);
      if (!rows) continue;
      for (const row of rows) {
        out.push(row);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  async findByMsisdns(msisdns: readonly string[], options: FindByCellIdsOptions = {}): Promise<TelecomSubscriber[]> {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const out: TelecomSubscriber[] = [];
    for (const msisdn of msisdns) {
      const row = this.byMsisdn.get(msisdn);
      if (row) {
        out.push(row);
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}
