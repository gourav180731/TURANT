import { loadConfig, type ParsedEnvConfig } from '../config/env.js';
import { capZoneToGeoZone } from '../utils/geometry.js';
import { getLogger } from '../utils/logger.js';
import { TowerResolver } from '../modules/02-cell-site-identification/resolver.js';
import type { TowerSource } from '../modules/02-cell-site-identification/tower-source.js';
import type { CellTower, GeoZone } from '../types/tower.js';
import type { CapAlert } from '../types/cap.js';
import { deduplicate } from '../modules/05-dedup/dedupe.js';
import { orchestrateAlertPipeline } from '../modules/13-parallel-processing/orchestrator.js';
import { getSubscriberMatcher } from './subscriber-matcher.js';
import {
  pipelineStatusStore,
  type PipelineStage,
  type PipelineStatusRecord,
} from './pipeline-status.js';

const logger = getLogger();

/**
 * Automatic end-to-end pipeline orchestrator.
 *
 * After a CAP alert is successfully ingested (module 01), this runs the real
 * chain automatically:
 *
 *   01 ingest → 02 tower resolution → 03/04 subscriber matching → 05 dedup → 13 submit
 *
 * The chain stops cleanly and loudly at the first stage whose real input is
 * missing, and never fabricates what is absent:
 *
 *   - Module 02: the alert's zone is built from its real CAP geometries and
 *     resolved through TowerResolver. If the configured tower source throws
 *     (e.g. DATABASE_URL / TOWER_HTTP_BASE_URL not configured), the pipeline
 *     logs `pipeline.halted` and stops here — it never continues with made-up
 *     towers.
 *   - Modules 03/04: no real SubscriberMatcher is registered today (they are
 *     PLAN.md-only, waiting on C-DOT's subscriber DB), so the pipeline halts
 *     with an explicit, visible "awaiting subscriber data" status.
 *   - Modules 05 → 13: the dissemination leg (dedup + real SMPP submission)
 *     is built and runs only when a real subscriber matcher actually returns
 *     data. It is not stubbed or faked to "exercise" the path today.
 *
 * Every stage writes to the shared pipeline-status store, and the whole run is
 * audited against the alert id.
 */
export interface RunPipelineInput {
  alert: CapAlert;
  capIdentifier: string;
  alertId: string;
  cfg?: ParsedEnvConfig;
  /** Override the resolver (tests inject a stub source through it). */
  resolver?: TowerResolver;
  /** Test-only: bypass TowerResolver's config-selected source. */
  source?: TowerSource;
}

export async function runAlertPipeline(input: RunPipelineInput): Promise<PipelineStatusRecord> {
  const cfg = input.cfg ?? loadConfig();
  const resolver = input.resolver ?? new TowerResolver();
  const { alert, capIdentifier, alertId } = input;
  const log = logger.child({ alertId, capIdentifier });

  const running = (stage: PipelineStage, extra: Partial<PipelineStatusRecord> = {}): void => {
    pipelineStatusStore.update({ capIdentifier, status: 'running', stage, ...extra, updatedAtMs: Date.now() });
  };
  const halted = (stage: PipelineStage, reason: string, extra: Partial<PipelineStatusRecord> = {}): PipelineStatusRecord => {
    const rec: PipelineStatusRecord = {
      capIdentifier,
      status: 'halted',
      stage,
      haltedAt: stage,
      reason,
      ...extra,
      updatedAtMs: Date.now(),
    };
    pipelineStatusStore.update(rec);
    return rec;
  };

  running('ingested');
  log.info({ stage: 'ingested' }, 'pipeline.started');

  // ---- Module 02: cell site identification ----------------------------------
  running('tower-resolution');
  const zone = capZoneToGeoZone(alert.info.areas.flatMap((area) => area.geometries));
  if (zone.geometries.length === 0) {
    log.warn({ stage: 'tower-resolution' }, 'pipeline.halted — CAP alert has no geographic area');
    return halted('tower-resolution', 'CAP alert has no geographic area (no polygon/circle areas)');
  }

  let towers: CellTower[];
  try {
    towers = input.source
      ? await resolver.resolveWithSource(input.source, alertId, zone, { traceKey: capIdentifier })
      : await resolver.resolveTowers(alertId, zone, { traceKey: capIdentifier });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ err, stage: 'tower-resolution' }, 'pipeline.halted');
    return halted('tower-resolution', reason);
  }

  const towerCount = towers.length;
  running('tower-resolution', { towerCount });
  // Expose the real matched towers for the frontend's in-polygon markers.
  pipelineStatusStore.setTowers(
    capIdentifier,
    towers.map((t) => ({
      id: t.id,
      cellId: t.cellId,
      latitude: t.latitude,
      longitude: t.longitude,
      coverageRadiusM: t.coverageRadiusM,
    })),
  );
  log.info({ towerCount }, 'pipeline.towers_resolved');

  // ---- Modules 03/04: subscriber matching ----------------------------------
  // Today no real matcher exists, so the pipeline halts loudly here. The
  // config-derived flag AND a registered matcher are both required, so this can
  // never "appear available" before the real modules exist.
  if (!cfg.SUBSCRIBER_MATCHING_AVAILABLE || !getSubscriberMatcher()) {
    const reason = 'awaiting subscriber data — modules 03/04 not yet connected';
    log.warn({ stage: 'subscriber-matching' }, 'pipeline.halted');
    return halted('subscriber-matching', reason, { towerCount });
  }

  // ---- Modules 03/04 → 05 → 13 (dissemination leg, conditional) ------------
  return runDisseminationLeg({ alert, capIdentifier, alertId, cfg, towers, zone });
}

/** Real, real-only dissemination: match → dedup → submit. Runs when a matcher exists. */
export interface DisseminationInput {
  alert: CapAlert;
  capIdentifier: string;
  alertId: string;
  cfg: ParsedEnvConfig;
  towers: CellTower[];
  /** Alert zone (drawn polygon/circles) — used by the real C-DOT dump matcher. */
  zone: GeoZone;
}

export async function runDisseminationLeg(input: DisseminationInput): Promise<PipelineStatusRecord> {
  const { alert, capIdentifier, alertId, cfg, towers, zone } = input;
  const log = logger.child({ alertId, capIdentifier });
  const matcher = getSubscriberMatcher();
  if (!matcher) {
    throw new Error('runDisseminationLeg requires a registered SubscriberMatcher');
  }

  pipelineStatusStore.update({
    capIdentifier,
    status: 'running',
    stage: 'subscriber-matching',
    towerCount: towers.length,
    updatedAtMs: Date.now(),
  });
  log.info({ matcher: matcher.name, towers: towers.length }, 'pipeline.subscriber_match.start');

  const matches = await matcher.matchSubscribers(towers, { alertId, capIdentifier, zone });
  const matchedMsisdns = matches.flatMap((m) => m.msisdns);
  pipelineStatusStore.update({
    capIdentifier,
    status: 'running',
    stage: 'subscriber-matching',
    towerCount: towers.length,
    matchedCount: matchedMsisdns.length,
    updatedAtMs: Date.now(),
  });

  // Module 05 — dedup on the real matched list (marks t2 on the shared trace).
  const deduped = await deduplicate(matchedMsisdns, capIdentifier);
  pipelineStatusStore.update({
    capIdentifier,
    status: 'running',
    stage: 'dedup',
    towerCount: towers.length,
    matchedCount: matchedMsisdns.length,
    duplicatesRemoved: deduped.removedCount,
    expectedRecipients: deduped.deduplicated.length,
    updatedAtMs: Date.now(),
  });
  log.info({ original: matchedMsisdns.length, deduplicated: deduped.deduplicated.length }, 'pipeline.dedup.completed');

  // Modules 06/13 — real submission through module 13 (worker_threads default).
  const content = alert.info.headline ?? alert.info.description ?? alert.info.event;
  const result = await orchestrateAlertPipeline({
    alert,
    content,
    msisdns: deduped.deduplicated,
    cfg,
    traceKey: capIdentifier,
  });

  const rec: PipelineStatusRecord = {
    capIdentifier,
    status: 'completed',
    stage: 'done',
    towerCount: towers.length,
    matchedCount: matchedMsisdns.length,
    duplicatesRemoved: deduped.removedCount,
    expectedRecipients: deduped.deduplicated.length,
    submittedCount: result.aggregate.total,
    updatedAtMs: Date.now(),
  };
  pipelineStatusStore.update(rec);
  log.info({ ...result.aggregate }, 'pipeline.completed');
  return rec;
}
