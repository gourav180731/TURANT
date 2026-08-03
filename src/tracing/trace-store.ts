import { loadConfig } from '../config/env.js';
import { hasRedis, getRedis } from '../persistence/redis-client.js';
import type { AlertTraceRecord, TracePoint, TraceStage } from '../types/trace.js';
import { computeDeliveryPercentiles } from '../types/trace.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

interface MemRecord {
  capIdentifier: string;
  points: Partial<Record<TraceStage, TracePoint>>;
  expectedRecipients: number;
  deliveryDurationsMs: number[];
  updatedAtMs: number;
}

/**
 * Shared per-alert latency trace store, keyed by CAP alert identifier.
 *
 * Every module calls `mark()` at its stage boundary. Records live in memory and
 * are mirrored to Redis (when configured) so worker_threads and multiple
 * processes observe the same timeline. Redis persistence is best-effort: a
 * store that is not configured (or briefly down) must never break an alert.
 */
export class AlertTraceStore {
  private readonly mem = new Map<string, MemRecord>();

  /** Record that a stage completed. `epochMs` defaults to now. */
  async mark(capIdentifier: string, stage: TraceStage, label: string, epochMs: number = Date.now()): Promise<void> {
    const point: TracePoint = { stage, label, epochMs };
    const rec = this.mem.get(capIdentifier) ?? this.createMem(capIdentifier);
    rec.points[stage] = point;
    rec.updatedAtMs = Date.now();
    this.mem.set(capIdentifier, rec);

    await this.redisSetPoint(capIdentifier, point);
    logger.debug({ capIdentifier, stage, label, epochMs }, 'trace.mark');
  }

  /** Set the expected (post-dedup) recipient count — called by module 05. */
  async setExpectedRecipients(capIdentifier: string, count: number): Promise<void> {
    const rec = this.mem.get(capIdentifier) ?? this.createMem(capIdentifier);
    rec.expectedRecipients = count;
    rec.updatedAtMs = Date.now();
    this.mem.set(capIdentifier, rec);
    await this.redisSetField(capIdentifier, 'expected', String(count));
  }

  /**
   * Record one DLR arrival — called by module 11 for every receipt. The
   * duration is measured from t0 so percentiles are always relative to the
   * alert's ingestion moment.
   */
  async recordDelivery(capIdentifier: string, deliveredEpochMs: number): Promise<void> {
    const rec = this.mem.get(capIdentifier) ?? this.createMem(capIdentifier);
    const t0 = rec.points.t0;
    if (t0) {
      rec.deliveryDurationsMs.push(Math.max(0, deliveredEpochMs - t0.epochMs));
    }
    rec.updatedAtMs = Date.now();
    this.mem.set(capIdentifier, rec);
    await this.redisPushDelivery(capIdentifier, deliveredEpochMs);
  }

  /** Full record with computed deltas + percentiles. */
  async snapshot(capIdentifier: string): Promise<AlertTraceRecord | undefined> {
    const memRec = this.mem.get(capIdentifier);
    const redisDurations = await this.redisDeliveryDurations(capIdentifier);
    const redisPoints = await this.redisPoints(capIdentifier);

    if (!memRec && redisDurations.length === 0 && !redisPoints) return undefined;

    const points: Partial<Record<TraceStage, TracePoint>> = { ...redisPoints };
    if (memRec) {
      for (const [stage, point] of Object.entries(memRec.points) as [TraceStage, TracePoint][]) {
        points[stage] = point;
      }
    }

    const durations = new Set<number>([...redisDurations, ...(memRec?.deliveryDurationsMs ?? [])]);
    const deliveredCount = durations.size;
    const expected = memRec?.expectedRecipients ?? (redisPoints ? Number(await this.redisGetField(capIdentifier, 'expected')) : 0) ?? 0;
    const percentiles = computeDeliveryPercentiles([...durations]);

    return {
      capIdentifier,
      points,
      expectedRecipients: Number.isFinite(expected) ? expected : 0,
      deliveredCount,
      percentiles,
      updatedAtMs: memRec?.updatedAtMs ?? Date.now(),
    };
  }

  /** Most recently updated records (used by the latency dashboard). */
  async list(limit = 50): Promise<AlertTraceRecord[]> {
    const ids = [...this.mem.entries()]
      .sort((a, b) => b[1].updatedAtMs - a[1].updatedAtMs)
      .slice(0, limit)
      .map(([id]) => id);
    const out: AlertTraceRecord[] = [];
    for (const id of ids) {
      const rec = await this.snapshot(id);
      if (rec) out.push(rec);
    }
    return out;
  }

  private createMem(capIdentifier: string): MemRecord {
    return { capIdentifier, points: {}, expectedRecipients: 0, deliveryDurationsMs: [], updatedAtMs: Date.now() };
  }

  // ---- Redis mirror (best-effort) -----------------------------------------

  private traceKey(capIdentifier: string): string {
    return `trace:${capIdentifier}`;
  }

  private dlrKey(capIdentifier: string): string {
    return `trace:dlr:${capIdentifier}`;
  }

  private ttlSeconds(): number {
    return loadConfig().TRACE_TTL_HOURS * 3600;
  }

  private async redisSetPoint(capIdentifier: string, point: TracePoint): Promise<void> {
    if (!this.redisAvailable()) return;
    try {
      const r = getRedis();
      const key = this.traceKey(capIdentifier);
      await r.hset(key, point.stage, JSON.stringify(point));
      await r.expire(key, this.ttlSeconds());
    } catch (err) {
      logger.warn({ err }, 'trace.redis_set_point_failed');
    }
  }

  private async redisSetField(capIdentifier: string, field: string, value: string): Promise<void> {
    if (!this.redisAvailable()) return;
    try {
      const r = getRedis();
      const key = this.traceKey(capIdentifier);
      await r.hset(key, field, value);
      await r.expire(key, this.ttlSeconds());
    } catch (err) {
      logger.warn({ err }, 'trace.redis_set_field_failed');
    }
  }

  private async redisGetField(capIdentifier: string, field: string): Promise<string | undefined> {
    if (!this.redisAvailable()) return undefined;
    try {
      return (await getRedis().hget(this.traceKey(capIdentifier), field)) ?? undefined;
    } catch (err) {
      logger.warn({ err }, 'trace.redis_get_field_failed');
      return undefined;
    }
  }

  private async redisPushDelivery(capIdentifier: string, deliveredEpochMs: number): Promise<void> {
    if (!this.redisAvailable()) return;
    try {
      const r = getRedis();
      const key = this.dlrKey(capIdentifier);
      await r.rpush(key, String(deliveredEpochMs));
      await r.expire(key, this.ttlSeconds());
    } catch (err) {
      logger.warn({ err }, 'trace.redis_push_dlr_failed');
    }
  }

  private async redisDeliveryDurations(capIdentifier: string): Promise<number[]> {
    if (!this.redisAvailable()) return [];
    try {
      const raw = await getRedis().lrange(this.dlrKey(capIdentifier), 0, -1);
      return raw.map(Number).filter(Number.isFinite);
    } catch (err) {
      logger.warn({ err }, 'trace.redis_read_dlr_failed');
      return [];
    }
  }

  private async redisPoints(capIdentifier: string): Promise<Partial<Record<TraceStage, TracePoint>>> {
    if (!this.redisAvailable()) return {};
    try {
      const hash = await getRedis().hgetall(this.traceKey(capIdentifier));
      const points: Partial<Record<TraceStage, TracePoint>> = {};
      for (const stage of ['t0', 't1', 't2', 't3', 't4', 't5'] as TraceStage[]) {
        const raw = hash[stage];
        if (raw) {
          try {
            const p = JSON.parse(raw) as TracePoint;
            if (p && typeof p.epochMs === 'number') points[stage] = p;
          } catch {
            /* skip corrupt entry */
          }
        }
      }
      return points;
    } catch (err) {
      logger.warn({ err }, 'trace.redis_read_points_failed');
      return {};
    }
  }

  private redisAvailable(): boolean {
    return hasRedis() || loadConfig().REDIS_URL !== undefined;
  }
}

/** Process-wide singleton — all modules share one store. */
export const traceStore = new AlertTraceStore();
