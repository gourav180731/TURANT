import type { TelecomSubscriber } from '../entities/telecom-subscriber.js';

/**
 * SQL builders + row serialization for the telecom simulation's Postgres
 * persistence. Kept pure (no DB access) so the generated SQL and the COPY /
 * INSERT wire formats can be unit-tested without a live database.
 *
 * Two layers:
 *
 *   1. The sim's OWN schema (migration 002) — fixed column list, written by
 *      the seeder. Column names here must match `002_telecom_sim.sql`.
 *   2. Configurable lookups — the Postgres repository reads through
 *      SUBSCRIBER_COL_* names so it can later point at the real C-DOT table.
 */

/** Column order for the sim `subscribers` table (COPY + INSERT share it). */
export const SUBSCRIBER_COLUMNS = [
  'id', 'imsi', 'msisdn', 'imei', 'tmsi',
  'cell_id', 'tower_id', 'previous_cell_id', 'lac', 'tac',
  'rnc_id', 'enb_id', 'gnb_id', 'sector_id', 'technology',
  'status', 'attach_time', 'last_seen',
  'signal_rssi', 'rsrp', 'rsrq', 'sinr',
  'roaming_status', 'emergency_capable', 'volte_enabled', 'vonr_enabled',
  'device_vendor', 'device_model', 'sim_operator', 'home_plmn', 'visited_plmn',
  'apn', 'ipv4', 'ipv6',
  'registration_state', 'paging_state', 'mcc', 'mnc', 'operator',
  'created_at', 'updated_at',
] as const;

/** Serialize one subscriber to the sim table's CSV (COPY FROM STDIN) row. */
export function serializeSubscriberCsv(row: TelecomSubscriber): string {
  const cells = SUBSCRIBER_COLUMNS.map((col) => encodeCsv(columnValue(col, row)));
  return cells.join('\t');
}

function columnValue(col: (typeof SUBSCRIBER_COLUMNS)[number], row: TelecomSubscriber): string | number | boolean | null {
  switch (col) {
    case 'id':
      return row.id;
    case 'imsi':
      return row.imsi;
    case 'msisdn':
      return row.msisdn;
    case 'imei':
      return row.imei;
    case 'tmsi':
      return row.tmsi ?? null;
    case 'cell_id':
      return row.cellId;
    case 'tower_id':
      return row.towerId;
    case 'previous_cell_id':
      return row.previousCellId ?? null;
    case 'lac':
      return row.lac;
    case 'tac':
      return row.tac ?? null;
    case 'rnc_id':
      return row.rncId ?? null;
    case 'enb_id':
      return row.enbId ?? null;
    case 'gnb_id':
      return row.gnbId ?? null;
    case 'sector_id':
      return row.sectorId ?? null;
    case 'technology':
      return row.technology;
    case 'status':
      return row.status;
    case 'roaming_status':
      return row.roamingStatus;
    case 'device_vendor':
      return row.deviceVendor ?? null;
    case 'device_model':
      return row.deviceModel ?? null;
    case 'sim_operator':
      return row.simOperator ?? null;
    case 'home_plmn':
      return row.homePlmn ?? null;
    case 'visited_plmn':
      return row.visitedPlmn ?? null;
    case 'apn':
      return row.apn ?? null;
    case 'ipv4':
      return row.ipv4 ?? null;
    case 'ipv6':
      return row.ipv6 ?? null;
    case 'registration_state':
      return row.registrationState;
    case 'paging_state':
      return row.pagingState ?? null;
    case 'mcc':
      return row.mcc ?? null;
    case 'mnc':
      return row.mnc ?? null;
    case 'operator':
      return row.operator ?? null;
    case 'attach_time':
      return row.attachTime.toISOString();
    case 'last_seen':
      return row.lastSeen.toISOString();
    case 'created_at':
      return row.createdAt.toISOString();
    case 'updated_at':
      return row.updatedAt.toISOString();
    case 'signal_rssi':
      return row.signalRssi ?? null;
    case 'rsrp':
      return row.rsrp ?? null;
    case 'rsrq':
      return row.rsrq ?? null;
    case 'sinr':
      return row.sinr ?? null;
    case 'emergency_capable':
      return row.emergencyCapable ? 't' : 'f';
    case 'volte_enabled':
      return row.volteEnabled ? 't' : 'f';
    case 'vonr_enabled':
      return row.vonrEnabled ? 't' : 'f';
  }
}

/** Escape a field for the CSV/COPY wire format (tab-separated, LF rows). */
function encodeCsv(value: string | number | boolean | null): string {
  if (value === null) return '\\N';
  const str = String(value);
  if (str.includes('\t') || str.includes('\n') || str.includes('\r') || str.includes('\\')) {
    return str.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  }
  return str;
}

/** COPY header for the sim subscribers table (tab-delimited, custom escape). */
export function buildCopyFromSubscribersSql(table: string): string {
  return `COPY ${table} (${SUBSCRIBER_COLUMNS.join(', ')}) FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '\\N')`;
}

const PG_BIND_MAX_PARAMS = 32767;

/** Idempotent batched upsert keyed on IMSI. */
export function buildUpsertSubscribersSql(table: string, batch: readonly TelecomSubscriber[]): { text: string; values: unknown[] } {
  const cols = SUBSCRIBER_COLUMNS;
  const placeholdersPerRow = cols.length;
  const values: unknown[] = [];
  const rowGroups: string[] = [];
  for (let r = 0; r < batch.length; r++) {
    const row = batch[r]!;
    const group: string[] = [];
    for (let c = 0; c < cols.length; c++) {
      group.push(`$${r * placeholdersPerRow + c + 1}`);
      values.push(columnValue(cols[c]!, row));
    }
    rowGroups.push(`(${group.join(', ')})`);
  }
  if (values.length > PG_BIND_MAX_PARAMS) {
    throw new Error(
      `PostgreSQL Bind parameter limit exceeded: ${values.length} params` +
        ` (${batch.length} rows × ${placeholdersPerRow} cols). Limit is ${PG_BIND_MAX_PARAMS}.` +
        ` Reduce the batch to ≤ ${Math.floor(PG_BIND_MAX_PARAMS / placeholdersPerRow)} rows.`,
    );
  }
  const updates = cols
    .filter((col) => col !== 'imsi' && col !== 'id')
    .map((col) => `${col} = EXCLUDED.${col}`)
    .join(', ');
  const text = `
    INSERT INTO ${table} (${cols.join(', ')})
    VALUES ${rowGroups.join(', ')}
    ON CONFLICT (imsi) DO UPDATE SET ${updates};
  `;
  return { text, values };
}

/** Parameterized lookup of subscribers attached to a set of cell ids. */
export function buildFindByCellIdsSql(
  table: string,
  columns: { id: string; imsi: string; msisdn: string; cellId: string; towerId: string; technology: string; status: string; lastSeen: string },
  cellIds: readonly string[],
  limit: number,
): { text: string; values: unknown[] } {
  const text = `
    SELECT ${columns.id} AS id, ${columns.imsi} AS imsi, ${columns.msisdn} AS msisdn,
           ${columns.cellId} AS cell_id, ${columns.towerId} AS tower_id,
           ${columns.technology} AS technology, ${columns.status} AS status,
           ${columns.lastSeen} AS last_seen
    FROM ${table}
    WHERE ${columns.cellId} = ANY($1)
    LIMIT ${limit};
  `;
  return { text, values: [cellIds] };
}

/** Parameterized lookup of full records by MSISDN list. */
export function buildFindByMsisdnsSql(
  table: string,
  columns: { msisdn: string },
  msisdns: readonly string[],
  limit: number,
): { text: string; values: unknown[] } {
  const text = `
    SELECT *
    FROM ${table}
    WHERE ${columns.msisdn} = ANY($1)
    LIMIT ${limit};
  `;
  return { text, values: [msisdns] };
}
