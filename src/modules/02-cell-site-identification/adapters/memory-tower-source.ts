import { getTowerStore } from '../../../telecom/tower-store.js';
import type { CellTower, GeoZone } from '../../../types/tower.js';
import { getLogger } from '../../../utils/logger.js';
import type { FindTowersOptions, TowerSource } from '../tower-source.js';

const logger = getLogger();

/**
 * Memory tower source — the telecom simulation's in-process resolver path.
 *
 * Active only when TOWER_SOURCE_MODE=memory (which the sim sets automatically
 * for the memory subscriber DB mode). Reads the towers the simulator generated
 * and applies the same radius-coverage matching the PostGIS adapter uses, so
 * module 02 behaves identically against the seeded DB and the in-memory store.
 */
export class MemoryTowerSource implements TowerSource {
  readonly name = 'memory';

  async findTowersInZone(zone: GeoZone, options: FindTowersOptions = {}): Promise<CellTower[]> {
    const limit = options.limit ?? 100_000;
    const towers = getTowerStore().findTowersInZone(zone, limit);
    logger.info({ count: towers.length }, 'cell.match.memory.query');
    return towers;
  }
}
