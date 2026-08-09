import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfig } from '../src/config/env.js';
import {
  buildStageCellIdsSql,
  buildLoadTargetCellsSql,
  buildMatchStatsSql,
  buildStreamRecipientsSql,
} from '../src/telecom/matcher/cell-subscriber-bridge-sql.js';

afterEach(() => {
  delete process.env.CELL_SUBSCRIBER_MAPPING_TABLE;
  delete process.env.SUBSCRIBER_DUMP_TABLE;
  resetConfig();
});

describe('cell→(lac,cisac) bridge — SQL builders (pure, no DB)', () => {
  it('stages a per-session temp table for the target cell ids', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    resetConfig();
    const { text } = buildStageCellIdsSql(loadConfig());
    expect(text).toContain('CREATE TEMP TABLE IF NOT EXISTS turant_target_cells');
    expect(text).toContain('UNIQUE (cell_id)');
    expect(text).toContain('ON COMMIT DROP');
  });

  it('bulk-loads the target cells deduplicated on the way in', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    resetConfig();
    const { text, values } = buildLoadTargetCellsSql(loadConfig(), ['10000', '10001', '10000']);
    expect(text).toContain('INSERT INTO turant_target_cells');
    expect(text).toContain('ON CONFLICT (cell_id) DO NOTHING');
    expect(values).toEqual(['10000', '10001']);
  });

  it('renders the resolve+match stats over the mapping + dump composite key', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    resetConfig();
    const { text } = buildMatchStatsSql(loadConfig());
    expect(text).toContain('FROM turant_target_cells');
    expect(text).toContain('JOIN cell_subscriber_mapping m');
    expect(text).toContain('ON m.cell_id = t.cell_id');
    expect(text).toContain('JOIN subscriber_dump s');
    expect(text).toContain('ON s.lac = r.lac');
    expect(text).toContain('AND s.cisac = r.cisac');
    expect(text).toContain('COUNT(DISTINCT s.msisdn)');
    expect(text).toContain('AS unresolved_cells');
  });

  it('renders the stream statement as a deduplicated recipient cursor', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    resetConfig();
    const { text } = buildStreamRecipientsSql(loadConfig());
    expect(text).toContain('SELECT DISTINCT s.msisdn AS msisdn');
    expect(text).toContain('JOIN cell_subscriber_mapping m');
    expect(text).toContain('JOIN subscriber_dump s');
    expect(text).toContain('ON s.lac = m.lac');
    expect(text).toContain('AND s.cisac = m.cisac');
    expect(text).toContain('WHERE s.msisdn IS NOT NULL');
  });

  it('returns a no-op statement when there are no cell ids to stage', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    resetConfig();
    const { text, values } = buildLoadTargetCellsSql(loadConfig(), []);
    expect(text).toContain('WHERE false');
    expect(values).toEqual([]);
  });
});
