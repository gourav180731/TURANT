import { afterEach, describe, expect, it } from 'vitest';
import { resetConfig } from '../src/config/env.js';
import { InMemorySubscriberRepository } from '../src/telecom/repositories/in-memory-subscriber-repository.js';
import {
  buildCopyFromSubscribersSql,
  buildFindByCellIdsSql,
  buildUpsertSubscribersSql,
  serializeSubscriberCsv,
} from '../src/telecom/repositories/sql-builders.js';
import {
  createSubscriberRepository,
  SubscriberRepositoryNotConfiguredError,
} from '../src/telecom/services/simulator.js';
import type { TelecomSubscriber } from '../src/telecom/entities/telecom-subscriber.js';

function row(overrides: Partial<TelecomSubscriber> = {}): TelecomSubscriber {
  const now = new Date();
  return {
    id: '404685509376597',
    imsi: '404685509376597',
    msisdn: '919868419126',
    imei: '359098967046943',
    cellId: '9C81',
    towerId: '12977',
    lac: '0451',
    technology: 'LTE',
    status: 'ACTIVE',
    attachTime: now,
    lastSeen: now,
    roamingStatus: 'HOME',
    emergencyCapable: true,
    volteEnabled: true,
    vonrEnabled: false,
    deviceVendor: 'SAMSUNG',
    deviceModel: 'Galaxy A14',
    simOperator: 'MTNL',
    homePlmn: '404-68',
    apn: 'internet',
    ipv4: '100.64.0.1',
    registrationState: 'REGISTERED',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.USE_DUMMY_SUBSCRIBER_DB;
  resetConfig();
});

describe('telecom — in-memory subscriber repository', () => {
  it('upserts idempotently by IMSI', async () => {
    const repo = new InMemorySubscriberRepository();
    const a = row({ imsi: '404685509376597', msisdn: '919868419126', cellId: '9C81' });
    const b = row({ imsi: '404685509376598', msisdn: '919868419127', cellId: 'A12F' });

    expect(await repo.upsertSubscribers([a, b])).toBe(2);
    expect(await repo.count()).toBe(2);

    // Same IMSI again — idempotent (returns 0 new inserts, count unchanged).
    const a2 = row({ imsi: '404685509376597', msisdn: '919868419126', cellId: '9C81' });
    expect(await repo.upsertSubscribers([a2])).toBe(0);
    expect(await repo.count()).toBe(2);
  });

  it('finds subscribers by cell id and by MSISDN', async () => {
    const repo = new InMemorySubscriberRepository();
    await repo.upsertSubscribers([
      row({ imsi: '1', msisdn: '919000000001', cellId: '9C81', towerId: '12977' }),
      row({ imsi: '2', msisdn: '919000000002', cellId: '9C81', towerId: '12977' }),
      row({ imsi: '3', msisdn: '919000000003', cellId: 'BEEF', towerId: '13000' }),
    ]);

    const byCell = await repo.findByCellIds(['9C81']);
    expect(byCell).toHaveLength(2);
    expect(byCell.map((r) => r.msisdn).sort()).toEqual(['919000000001', '919000000002']);

    const limited = await repo.findByCellIds(['9C81'], { limit: 1 });
    expect(limited).toHaveLength(1);

    const byMsisdn = await repo.findByMsisdns(['919000000003', 'nope']);
    expect(byMsisdn).toHaveLength(1);
    expect(byMsisdn[0]!.imsi).toBe('3');
  });
});

describe('telecom — repository factory', () => {
  it('throws "Real C-DOT Subscriber Repository Not Configured" when the sim is off', () => {
    process.env.USE_DUMMY_SUBSCRIBER_DB = 'false';
    resetConfig();
    expect(() => createSubscriberRepository()).toThrow(SubscriberRepositoryNotConfiguredError);
    try {
      createSubscriberRepository();
    } catch (err) {
      expect((err as Error).message).toBe('Real C-DOT Subscriber Repository Not Configured');
    }
  });

  it('returns the in-memory repository in memory mode', () => {
    process.env.USE_DUMMY_SUBSCRIBER_DB = 'true';
    process.env.SUBSCRIBER_DB_MODE = 'memory';
    resetConfig();
    expect(createSubscriberRepository().name).toBe('telecom-sim:memory');
  });
});

describe('telecom — SQL builders (pure, no DB)', () => {
  it('builds a COPY header with the full sim column list', () => {
    const sql = buildCopyFromSubscribersSql('subscribers');
    expect(sql).toContain('COPY subscribers (');
    expect(sql).toContain('imsi');
    expect(sql).toContain('last_seen');
    expect(sql).toContain('FROM STDIN');
  });

  it('serializes a subscriber row to the tab-delimited COPY wire format', () => {
    const csv = serializeSubscriberCsv(row());
    const fields = csv.split('\t');
    expect(fields).toHaveLength(41);
    expect(fields[0]).toBe('404685509376597'); // id
    expect(fields[1]).toBe('404685509376597'); // imsi
    expect(fields[2]).toBe('919868419126'); // msisdn
    expect(fields[22]).toBe('HOME'); // roaming_status
    expect(fields[23]).toBe('t'); // emergency_capable
  });

  it('builds an idempotent upsert keyed on IMSI', () => {
    const { text, values } = buildUpsertSubscribersSql('subscribers', [row()]);
    expect(text).toContain('INSERT INTO subscribers');
    expect(text).toContain('ON CONFLICT (imsi) DO UPDATE');
    expect(text).toContain('cell_id = EXCLUDED.cell_id');
    expect(values).toHaveLength(41);
  });

  it('builds a parameterized cell-id lookup with a limit', () => {
    const { text, values } = buildFindByCellIdsSql(
      'subscribers',
      { id: 'id', imsi: 'imsi', msisdn: 'msisdn', cellId: 'cell_id', towerId: 'tower_id', technology: 'technology', status: 'status', lastSeen: 'last_seen' },
      ['9C81', 'BEEF'],
      1000,
    );
    expect(text).toContain('WHERE cell_id = ANY($1)');
    expect(text).toContain('LIMIT 1000');
    expect(values).toEqual([['9C81', 'BEEF']]);
  });
});
