import type { CellTower } from '../../types/tower.js';
import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import { getLogger } from '../../utils/logger.js';
import type { SubscriberMatch, SubscriberMatcher } from '../../pipeline/subscriber-matcher.js';
import type { SubscriberRepository } from '../repositories/subscriber-repository.js';

const log = getLogger();

/**
 * TelecomSimSubscriberMatcher — modules 03/04 drop-in.
 *
 * Implements the pipeline's SubscriberMatcher contract against the simulated
 * subscriber repository. For every tower the cell-site resolver returned, it
 * fetches the subscribers currently attached to that cell (chunked, via the
 * repository) and returns their real MSISDNs.
 *
 * Because it speaks the same interface the future C-DOT matcher will use,
 * swapping in the real subscriber database requires no pipeline changes —
 * only `registerSubscriberMatcher(new CdotSubscriberMatcher(...))`.
 */
export class TelecomSimSubscriberMatcher implements SubscriberMatcher {
  readonly name = 'telecom-sim';

  constructor(
    private readonly repo: SubscriberRepository,
    private readonly cfg: ParsedEnvConfig = loadConfig(),
  ) {}

  async matchSubscribers(
    towers: readonly CellTower[],
    ctx: { alertId: string; capIdentifier: string },
  ): Promise<SubscriberMatch[]> {
    const { alertId, capIdentifier } = ctx;
    const start = performance.now();

    const cellIds = towers.map((t) => t.cellId).filter((c) => c);
    const uniqueCellIds = Array.from(new Set(cellIds));

    const rows = await this.repo.findByCellIds(uniqueCellIds, { limit: this.cfg.TOWER_MATCH_LIMIT });
    const byCell = new Map<string, string[]>();
    for (const row of rows) {
      const list = byCell.get(row.cellId) ?? [];
      list.push(row.msisdn);
      byCell.set(row.cellId, list);
    }

    const matches: SubscriberMatch[] = towers.map((tower) => ({
      towerId: tower.id,
      msisdns: byCell.get(tower.cellId) ?? [],
    }));

    const matched = matches.reduce((n, m) => n + m.msisdns.length, 0);
    const elapsedMs = performance.now() - start;
    log.info({ alertId, capIdentifier, towers: towers.length, matched, elapsedMs }, 'subscriber.match.completed');
    return matches;
  }
}
