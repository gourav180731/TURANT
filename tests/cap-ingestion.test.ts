import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CapParseError,
  capTiming,
  parseCapTimestamp,
  parseCapXml,
  selectInfo,
} from '../src/modules/01-cap-ingestion/cap-parser.js';
import { capAlertSchema } from '../src/modules/01-cap-ingestion/cap-schema.js';
import { CapIngestionService, capIdentifierOf } from '../src/modules/01-cap-ingestion/service.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cap.xml');
const fixtureXml = readFileSync(fixturePath, 'utf8');

describe('CAP ingestion — parser (requirement #1)', () => {
  it('parses the alert envelope fields', () => {
    const alert = parseCapXml(fixtureXml);
    expect(alert.identifier).toBe('CDOT-EWS-2026-000123');
    expect(alert.sender).toBe('ews@cdot.in');
    expect(alert.sent).toBe('2026-08-04T06:00:00+05:30');
    expect(alert.status).toBe('Actual');
    expect(alert.msgType).toBe('Alert');
    expect(alert.scope).toBe('Public');
    expect(alert.source).toBe('National Cyclone Early Warning');
    expect(alert.code).toEqual(['IND-CYCLONE-01']);
    expect(alert.rawXml).toContain('<alert');
  });

  it('parses the selected info block with language preference', () => {
    const alert = parseCapXml(fixtureXml, { preferredLanguage: 'en-IN' });
    expect(alert.info.language).toBe('en-IN');
    expect(alert.info.event).toBe('Severe Cyclonic Storm');
    expect(alert.info.severity).toBe('Severe');
    expect(alert.info.urgency).toBe('Immediate');
    expect(alert.info.certainty).toBe('Likely');
    expect(alert.info.category).toEqual(['Met', 'Geo']);
    expect(alert.info.expires).toBe('2026-08-04T09:00:00+05:30');
    expect(alert.info.headline).toContain('Cyclonic Storm');
    expect(alert.info.eventCode).toEqual([
      { valueName: 'IND-WMO-CLASS', value: 'CS' },
    ]);
  });

  it('selects the preferred language info block and falls back to first', () => {
    const en = parseCapXml(fixtureXml, { preferredLanguage: 'en-IN' });
    expect(en.info.language).toBe('en-IN');
    const fallback = parseCapXml(fixtureXml, { preferredLanguage: 'fr-FR' });
    expect(fallback.info.language).toBe('en-IN');
  });

  it('parses area polygons into CAP coordinates (lat,lng)', () => {
    const alert = parseCapXml(fixtureXml);
    const area = alert.info.areas[0]!;
    expect(area.areaDesc).toContain('Coastal districts');
    expect(area.polygons).toHaveLength(1);
    expect(area.polygons[0]![0]).toEqual({ lat: 28, lng: 84.5 });
    expect(area.polygons[0]!.length).toBeGreaterThanOrEqual(4);
    expect(area.geocodes).toContainEqual({ valueName: 'DISTRICT', value: 'BHOJPUR' });
  });

  it('parses CAP circles with km->m radius conversion', () => {
    const alert = parseCapXml(fixtureXml);
    const area = alert.info.areas[0]!;
    expect(area.circles).toHaveLength(1);
    expect(area.circles[0]!.center).toEqual({ lat: 27, lng: 84.5 });
    expect(area.circles[0]!.radiusMeters).toBe(25000);
    expect(area.geometries).toHaveLength(2);
    expect(area.geometries[0]).toMatchObject({ type: 'Polygon' });
    expect(area.geometries[1]).toMatchObject({ type: 'Circle', radiusMeters: 25000 });
  });

  it('computes timing from the expires timestamp', () => {
    const alert = parseCapXml(fixtureXml);
    const timing = capTiming(alert);
    expect(timing.expiresAt?.toISOString()).toBe(new Date('2026-08-04T09:00:00+05:30').toISOString());
  });

  it('rejects empty, malformed and non-conforming documents', () => {
    expect(() => parseCapXml('   ')).toThrow(CapParseError);
    expect(() => parseCapXml('<not-an-alert><foo/></not-an-alert>')).toThrow(CapParseError);
    expect(() => parseCapXml('<alert>not closed')).toThrow(CapParseError);
    expect(() => parseCapXml('<alert><sender>s</sender></alert>')).toThrow(/identifier/);
  });

  it('produces a stable cap identifier for audit correlation', () => {
    const alert = parseCapXml(fixtureXml);
    expect(capIdentifierOf(alert)).toBe('ews@cdot.in:CDOT-EWS-2026-000123');
  });
});

describe('CAP ingestion — service (requirement #1)', () => {
  it('parses + validates through the service boundary', async () => {
    const service = new CapIngestionService();
    const result = await service.ingest(fixtureXml);
    expect(result.capIdentifier).toBe('ews@cdot.in:CDOT-EWS-2026-000123');
    expect(result.expiresAt).toBe(new Date('2026-08-04T09:00:00+05:30').toISOString());
    expect(result.alert.info.event).toBe('Severe Cyclonic Storm');
  });

  it('service output satisfies the runtime CAP schema', () => {
    const service = new CapIngestionService();
    const alert = service.parse(fixtureXml);
    expect(capAlertSchema.safeParse(alert).success).toBe(true);
  });
});

describe('CAP ingestion — date helper', () => {
  it('parses ISO and RFC dates, null for garbage', () => {
    expect(parseCapTimestamp('2026-08-04T09:00:00+05:30')).toBeInstanceOf(Date);
    expect(parseCapTimestamp('Thu, 04 Aug 2026 03:30:00 GMT')).toBeInstanceOf(Date);
    expect(parseCapTimestamp('not-a-date')).toBeNull();
    expect(parseCapTimestamp(undefined)).toBeNull();
  });
});

describe('CAP ingestion — selectInfo', () => {
  it('returns first info when list is non-empty', () => {
    const alert = parseCapXml(fixtureXml);
    expect(selectInfo(alert.infos, undefined)).toBe(alert.infos[0]);
  });
});
