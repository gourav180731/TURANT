/**
 * Telecom Master Dataset seeder.
 *
 * Generates a realistic, production-like BTS dataset (~5,000 cells across
 * Delhi NCR by default — `TELECOM_MASTER_TOWER_COUNT`) and inserts it into the
 * C-DOT reference-schema table `telecom_master`, plus the sim's own tables
 * (`sim_cell_towers`, `cell_towers`) and the subscribers attached to those
 * cells. Module 02 reads the towers (TOWER_TABLE=telecom_master or the
 * `cell_towers` subset); modules 03/04 match subscribers against the same cell
 * ids. Deterministic (SIM_SEED), idempotent and resumable.
 *
 * Usage:
 *   USE_DUMMY_SUBSCRIBER_DB=true SUBSCRIBER_DB_MODE=postgres \
 *   TELECOM_MASTER_TOWER_COUNT=5000 \
 *   DATABASE_URL=postgres://... \
 *   npm run seed:telecom-master
 *
 * At the end it prints the dataset summary (towers, operators, technology
 * distribution, geographic distribution).
 */

import { loadConfig } from '../src/config/env.js';
import { getLogger, flushLogger } from '../src/utils/logger.js';
import { TelecomMasterSeeder } from '../src/telecom/seeders/index.js';
import { TelecomSimulator } from '../src/telecom/services/simulator.js';

const log = getLogger();

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.USE_DUMMY_SUBSCRIBER_DB) {
    throw new Error('seed:telecom-master requires USE_DUMMY_SUBSCRIBER_DB=true');
  }
  if (cfg.SUBSCRIBER_DB_MODE !== 'postgres') {
    throw new Error('seed:telecom-master requires SUBSCRIBER_DB_MODE=postgres');
  }
  if (!cfg.DATABASE_URL) {
    throw new Error('seed:telecom-master requires DATABASE_URL');
  }

  const count = cfg.TELECOM_MASTER_TOWER_COUNT;
  const towers = new TelecomSimulator(cfg).generateTowersForCount(count);

  const byOperator = countBy(towers, (t) => t.serviceProvider ?? t.operatorShortName ?? '?');
  const byTech = countBy(towers, (t) => t.technology);
  const byDistrict = countBy(towers, (t) => `${t.district} (${t.state})`);
  const byCity = countBy(towers, (t) => t.city);
  const bySiteType = countBy(towers, (t) => t.siteType ?? '?');

  log.info(
    {
      towers: towers.length,
      subscribers: cfg.DUMMY_SUBSCRIBER_COUNT,
      seed: cfg.SIM_SEED,
      partitions: cfg.SUBSCRIBER_PARTITIONS,
    },
    'telecom-master.start',
  );

  const seeder = new TelecomMasterSeeder(cfg);
  const started = performance.now();
  const result = await seeder.seedAll({
    towers,
    subscriberCount: cfg.DUMMY_SUBSCRIBER_COUNT,
  });
  const elapsedMs = performance.now() - started;

  log.info(
    {
      ...result,
      ratePerSec: result.masterRows > 0 ? Math.round(result.masterRows / (elapsedMs / 1000)) : 0,
      elapsedMs: Math.round(elapsedMs),
    },
    'telecom-master.completed',
  );

  // --- Dataset summary (verification output) --------------------------------
  const rows = (label: string, map: Map<string, number>): string =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `  ${k.padEnd(38)} ${String(n).padStart(6)}  (${((n / count) * 100).toFixed(1)}%)`)
      .join('\n');

  const summary = [
    '============================================================',
    ' TURANT — Telecom Master Dataset summary',
    '============================================================',
    `  Generated towers          ${result.towers}`,
    `  telecom_master rows       ${result.masterRows}`,
    `  subscribers               ${result.subscribers.generated} generated / ${result.subscribers.skipped} skipped / ${result.subscribers.existing} existing`,
    `  SIM_SEED                  ${cfg.SIM_SEED}`,
    '',
    `Operators generated (${byOperator.size}):`,
    rows('operator', byOperator),
    '',
    `Technology distribution (${byTech.size}):`,
    rows('technology', byTech),
    '',
    `Site types (${bySiteType.size}):`,
    rows('site_type', bySiteType),
    '',
    `Geographic distribution (${byDistrict.size} districts):`,
    rows('district', byDistrict),
    '',
    `Cities (${byCity.size}):`,
    rows('city', byCity),
    '============================================================',
  ].join('\n');

  // Print straight to stdout (independent of pino/audit formatting).
  process.stdout.write(`\n${summary}\n`);
}

main()
  .then(() => flushLogger())
  .catch((err) => {
    log.error({ err }, 'telecom-master.failed');
    void flushLogger().finally(() => (process.exitCode = 1));
  });
