import { describe, expect, it, vi } from 'vitest';
import { buildSmsMessages, submitAlertBatch } from '../src/modules/07-smpp-integration/batch-submitter.js';
import { buildSubmitSmPdu, encodeMessageContent, smppErrorText } from '../src/modules/07-smpp-integration/smpp-client.js';
import { loadConfig } from '../src/config/env.js';
import { ExpiryGuard } from '../src/modules/06-expiry-control/expiry-guard.js';

const cfg = loadConfig();

describe('module 07 — submit_sm construction (pure, no SMSC)', () => {
  it('builds SmsMessage[] carrying module 08 + module 09 fields', () => {
    const expiry = new Date('2026-08-04T03:30:00Z');
    const messages = buildSmsMessages('ALERT-1', 'Storm warning', ['9190000001', '9190000002'], cfg, expiry, 3);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      alertId: 'ALERT-1',
      msisdn: '9190000001',
      priorityFlag: 3,
      dataCoding: cfg.SMS_DATA_CODING,
    });
    expect(messages[0].validityPeriod).toBe(expiry);
  });

  it('encodes the validity_period and priority_flag into the PDU', () => {
    const message = buildSmsMessages('ALERT-1', 'Storm', ['9190000001'], cfg, new Date('2026-08-04T03:30:00Z'), 3)[0]!;
    const pdu = buildSubmitSmPdu(message, cfg);

    expect(pdu.priority_flag).toBe(3);
    expect(pdu.validity_period).toBe('2608040330000000'); // 03:30Z, UTC form
    expect(pdu.destination_addr).toBe('9190000001');
    expect(pdu.registered_delivery).toBe(cfg.SMS_REGISTERED_DELIVERY);
    expect(pdu.data_coding).toBe(cfg.SMS_DATA_CODING === 'ucs2' ? 8 : 0);
  });

  it('fails loudly on over-length content rather than truncating', () => {
    expect(() => encodeMessageContent('x'.repeat(161), '7bit')).toThrow(/exceeds/);
    expect(() => encodeMessageContent('x'.repeat(71), 'ucs2')).toThrow(/exceeds/);
    expect(() => encodeMessageContent('', '7bit')).toThrow(/empty/);
    expect(encodeMessageContent('x'.repeat(160), '7bit')).toBe('x'.repeat(160));
  });

  it('maps common command_status codes to names', () => {
    expect(smppErrorText(0x400)).toBe('ESME_RTHROTTLED');
    expect(smppErrorText(123)).toBe('command_status=123');
    expect(smppErrorText(undefined)).toBe('command_status not present');
  });
});

describe('module 07 — batch submission path', () => {
  it('reports awaitingCredentials instead of fabricating when SMPP is unconfigured', async () => {
    const cfgNoSmpp = { ...cfg, SMPP_HOST: undefined, SMPP_SYSTEM_ID: undefined };
    const summary = await submitAlertBatch('ALERT-1', 'Storm', ['9190000001'], { cfg: cfgNoSmpp });
    expect(summary.awaitingCredentials).toBe(true);
    expect(summary.accepted).toBe(0);
  });

  it('halts before submission when the alert already expired', async () => {
    const cfgWithSmpp = { ...cfg, SMPP_HOST: 'smpp.sandbox.cdot.in', SMPP_SYSTEM_ID: 'turant' };
    const guard = new ExpiryGuard({
      expiresAt: new Date('2026-08-04T03:30:00Z'),
      now: () => new Date('2026-08-04T04:00:00Z'),
    });
    const summary = await submitAlertBatch('ALERT-1', 'Storm', ['9190000001'], { cfg: cfgWithSmpp, guard });
    expect(summary.gaveUpExpired).toBe(0);
    expect(summary.awaitingCredentials).toBe(false);
    expect(summary.accepted).toBe(0);
  });
});
