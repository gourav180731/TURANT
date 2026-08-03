import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../config/env.js';
import { getLogger } from '../../utils/logger.js';
import type { CapIngestionService } from './service.js';

const logger = getLogger();

/**
 * CAP directory poller (poll mode) — requirement #1.
 *
 * Monitors a drop directory where the EWS deposits CAP XML files. Each file is
 * ingested once, then archived (or deleted when no archive dir is configured).
 * Parse failures are quarantined under <archive>/.failed/ so the source can
 * recover them without reprocessing duplicates.
 */
export class CapDirectoryPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly service: CapIngestionService) {}

  start(): void {
    const cfg = loadConfig();
    if (!cfg.CAP_POLL_ENABLED) {
      logger.info('CAP_POLL_ENABLED=false; poller not started');
      return;
    }
    if (!cfg.CAP_POLL_DIR) {
      throw new Error('CAP_POLL_ENABLED=true but CAP_POLL_DIR is not set in .env');
    }
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), cfg.CAP_POLL_INTERVAL_MS);
    this.timer.unref();
    logger.info({ dir: cfg.CAP_POLL_DIR, intervalMs: cfg.CAP_POLL_INTERVAL_MS }, 'cap.poll.started');
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const cfg = loadConfig();
    try {
      const files = (await fs.readdir(cfg.CAP_POLL_DIR!)).filter((f) => f.toLowerCase().endsWith('.xml'));
      for (const file of files) {
        if (!this.running) break;
        const fullPath = path.join(cfg.CAP_POLL_DIR!, file);
        await this.processFile(fullPath, cfg.CAP_POLL_ARCHIVE_DIR);
      }
    } catch (err) {
      logger.error({ err }, 'cap.poll.error');
    }
  }

  private async processFile(fullPath: string, archiveDir?: string): Promise<void> {
    const log = logger.child({ file: fullPath });
    try {
      const xml = await fs.readFile(fullPath, 'utf8');
      const result = await this.service.ingest(xml);
      log.info({ capIdentifier: result.capIdentifier, alertId: result.alertId }, 'cap.poll.ingested');
      await this.finalize(fullPath, archiveDir, false);
    } catch (err) {
      log.error({ err }, 'cap.poll.parse_failed');
      await this.finalize(fullPath, archiveDir, true);
    }
  }

  private async finalize(fullPath: string, archiveDir: string | undefined, failed: boolean): Promise<void> {
    if (!archiveDir) {
      await fs.unlink(fullPath).catch(() => undefined);
      return;
    }
    const day = new Date().toISOString().slice(0, 10);
    const targetDir = failed ? path.join(archiveDir, day, '.failed') : path.join(archiveDir, day);
    await fs.mkdir(targetDir, { recursive: true });
    const target = path.join(targetDir, path.basename(fullPath));
    await fs.rename(fullPath, target).catch(() => fs.copyFile(fullPath, target));
    if (target !== fullPath) await fs.unlink(fullPath).catch(() => undefined);
  }
}
