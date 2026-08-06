import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfig } from '../src/config/env.js';
import { buildSubscriberDumpZoneQuery } from '../src/telecom/matcher/subscriber-dump-sql.js';
import { PostgresSubscriberDumpMatcher } from '../src/telecom/matcher/subscriber-dump-matcher.js';
import type { GeoZone } from '../src/types/tower.js';

afterEach(() => {
  delete process.env.SUBSCRIBER_DUMP_TABLE;
  delete process.env.SUBSCRIBER_DUMP_MSISDN_COL;
  delete process.env.SUBSCRIBER_DUMP_GEOM_COL;
  resetConfig();
});

describe('real C-DOT subscriber dump — SQL builder (pure, no DB)', () => {
  it('builds a point-in-polygon query against the dump geometry column', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    process.env.SUBSCRIBER_DUMP_MSISDN_COL = 'msisdn';
    process.env.SUBSCRIBER_DUMP_GEOM_COL = 'geom';
    resetConfig();

    const zone: GeoZone = {
      geometries: [
        { type: 'Polygon', coordinates: [[[85, 30], [86, 30], [86, 31], [85, 31], [85, 30]]] },
        { type: 'Circle', center: { lat: 28.6, lng: 77.2 }, radiusMeters: 5000 },
      ],
    };

    const { text, values } = buildSubscriberDumpZoneQuery(loadConfig(), zone, 100);

    expect(text).toContain('FROM subscriber_dump s');
    expect(text).toContain('ST_Intersects(s.geom, z.geom)');
    expect(text).toContain('SELECT DISTINCT msisdn AS msisdn');
    expect(text).toContain('ST_GeomFromGeoJSON');
    expect(text).toContain('ST_Buffer');
    expect(text).toContain('LIMIT 100');
    // Two geometries → GeoJSON polygon value + 3 circle params (lng,lat,radius).
    expect(values).toHaveLength(4);
    expect(JSON.parse(values[0] as string).type).toBe('Polygon');
  });

  it('throws when the zone has no geometries', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    resetConfig();
    expect(() => buildSubscriberDumpZoneQuery(loadConfig(), { geometries: [] }, 10)).toThrow(
      'GeoZone has no geometries',
    );
  });
});

describe('real C-DOT subscriber dump — matcher wiring', () => {
  it('returns [] when no zone is present (no DB call)', async () => {
    const matcher = new PostgresSubscriberDumpMatcher();
    const result = await matcher.matchSubscribers([], { alertId: 'a', capIdentifier: 'c' });
    expect(result).toEqual([]);
  });
});
