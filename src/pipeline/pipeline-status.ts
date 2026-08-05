/**
 * Per-alert pipeline status store.
 *
 * The automatic end-to-end pipeline (module 01 → 02 → 03/04 → 05 → 13) writes
 * its progress here, keyed by the CAP alert identifier, so a caller can see —
 * via GET /api/v1/alerts/:capIdentifier/pipeline-status — exactly how far a
 * real alert travelled and, when it halted, why. Kept in memory like the
 * latency trace store: visibility for the current process's alerts.
 */

export type PipelineStatusKind = 'running' | 'halted' | 'completed';

/** The farthest stage a pipeline run has reached (or the stage that halted). */
export type PipelineStage =
  | 'ingested'
  | 'tower-resolution'
  | 'subscriber-matching'
  | 'dedup'
  | 'submission'
  | 'done';

export interface PipelineStatusRecord {
  capIdentifier: string;
  status: PipelineStatusKind;
  /** Farthest stage reached, or the stage the pipeline halted at. */
  stage: PipelineStage;
  /** Set when status === 'halted': the stage that could not proceed. */
  haltedAt?: PipelineStage;
  /** Human-readable reason when halted (never fabricated). */
  reason?: string;
  /** Towers identified for the alert's zone by module 02 (once resolved). */
  towerCount?: number;
  /** Subscribers matched by modules 03/04 (pre-dedup, when the leg runs). */
  matchedCount?: number;
  /** Duplicates removed by module 05 (real removed count). */
  duplicatesRemoved?: number;
  /** Intended recipients after dedup (module 05) — set when the leg runs. */
  expectedRecipients?: number;
  /** SMS actually submitted through module 13 (set when the leg completes). */
  submittedCount?: number;
  updatedAtMs: number;
}

/** Minimal tower record exposed to the frontend for matched-tower markers. */
export interface MatchedTower {
  id: string;
  cellId: string;
  latitude: number;
  longitude: number;
  coverageRadiusM?: number;
}

export class PipelineStatusStore {
  private readonly mem = new Map<string, PipelineStatusRecord>();
  /** Matched towers, keyed by capIdentifier (only when module 02 ran). */
  private readonly towers = new Map<string, MatchedTower[]>();

  update(rec: PipelineStatusRecord): void {
    this.mem.set(rec.capIdentifier, { ...rec, updatedAtMs: Date.now() });
  }

  get(capIdentifier: string): PipelineStatusRecord | undefined {
    return this.mem.get(capIdentifier);
  }

  /** Record the towers module 02 identified for an alert (real data). */
  setTowers(capIdentifier: string, towers: readonly MatchedTower[]): void {
    this.towers.set(capIdentifier, towers.map((t) => ({ ...t })));
  }

  /** Matched towers for an alert, or undefined if module 02 never ran. */
  getTowers(capIdentifier: string): MatchedTower[] | undefined {
    return this.towers.get(capIdentifier);
  }
}

/** Process-wide singleton — every pipeline run reports here. */
export const pipelineStatusStore = new PipelineStatusStore();
