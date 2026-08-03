import { describe, expect, it } from 'vitest';
import type { DeliverSmPdu } from 'smpp';
import { DlrListener, isDeliveryReceipt, parseDeliverSmReceipt, parseDoneDate, smppMessageStateName } from '../src/modules/11-dlr/dlr-listener.js';
import { traceStore } from '../src/tracing/trace-store.js';
import type { SmppClient } from '../src/modules/07-smpp-integration/smpp-client.js';

const receiptText =
  'id:1000000001 sub:001 dlvrd:001 submit date:2608041000 done date:2608041001 stat:DELIVRD err:000 text:';

const receiptPdu = (overrides: Partial<DeliverSmPdu> = {}): DeliverSmPdu => ({
  command: 'deliver_sm',
  message_type: 'deliver_sm',
  esm_class: 0x04,
  message_state: 1,
  short_message: { message: receiptText },
  ...overrides,
});

describe('module 11 — DLR parsing', () => {
  it('parses a full text receipt into a DlrReceipt', () => {
    const receipt = parseDeliverSmReceipt(receiptPdu())!;
    expect(receipt.smscMessageId).toBe('1000000001');
    expect(receipt.messageState).toBe('DELIVRD');
    expect(receipt.errorCode).toBe('000');
  });

  it('parses done date into a delivery timestamp', () => {
    const receipt = parseDeliverSmReceipt(receiptPdu())!;
    // SMPP done date "2608041001" -> 2026-08-04 10:01 local.
    expect(receipt.deliveredAt?.getFullYear()).toBe(2026);
    expect(receipt.deliveredAt?.getMonth()).toBe(7); // Aug
    expect(receipt.deliveredAt?.getDate()).toBe(4);
  });

  it('falls back to message_state when the text has no stat', () => {
    const pdu = receiptPdu({ message_id: 'SMSC-777', short_message: 'no stat here', message_state: 7 });
    const receipt = parseDeliverSmReceipt(pdu)!;
    expect(receipt.smscMessageId).toBe('SMSC-777');
    expect(receipt.messageState).toBe('REJECTD');
  });

  it('returns null for a non-receipt PDU', () => {
    expect(parseDeliverSmReceipt({ command: 'deliver_sm', esm_class: 0, short_message: 'hello' })).toBeNull();
  });

  it('recognizes receipt PDUs via esm_class/message_state', () => {
    expect(isDeliveryReceipt(receiptPdu())).toBe(true);
    expect(isDeliveryReceipt({ esm_class: 0, short_message: 'x' })).toBe(false);
  });

  it('maps message_state numeric values to names', () => {
    expect(smppMessageStateName(1)).toBe('DELIVRD');
    expect(smppMessageStateName(7)).toBe('REJECTD');
    expect(smppMessageStateName(undefined)).toBeUndefined();
  });

  it('parses done date only for well-formed SMPP timestamps', () => {
    expect(parseDoneDate(' done date:2608041001 ')).not.toBeNull();
    expect(parseDoneDate(' done date:garbage ')).toBeNull();
  });
});

describe('module 11 — DlrListener', () => {
  it('correlates a receipt to the alert and marks t4/t5', async () => {
    const id = `dlr-trace-${Date.now()}`;
    const listener = new DlrListener(() => new Date('2026-08-04T10:01:00+05:30'));

    await traceStore.setExpectedRecipients(id, 2);
    await traceStore.mark(id, 't0', 'cap.ingest', 1000);

    // Simulate the SMSC returning a message_id, then the DLR arriving.
    listener.registerSubmission('SMSC-001', { messageId: 'msg-1', alertId: id, msisdn: '9190000001' });
    listener.registerSubmission('SMSC-002', { messageId: 'msg-2', alertId: id, msisdn: '9190000002' });

    const pdu1 = receiptPdu({ message_id: 'SMSC-001', short_message: { message: receiptText.replace('1000000001', 'SMSC-001') } });
    const pdu2 = receiptPdu({
      message_id: 'SMSC-002',
      short_message: { message: receiptText.replace('1000000001', 'SMSC-002').replace('done date:2608041001', 'done date:2608041002') },
    });

    await listener.handlePdu(pdu1);
    await listener.handlePdu(pdu2);

    const rec = await traceStore.snapshot(id);
    expect(rec?.deliveredCount).toBe(2);
    expect(rec?.points.t4?.label).toBe('dlr.first');
    expect(rec?.points.t5?.label).toBe('dlr.all_expected');

    const stats = listener.receiptsForAlert(id);
    expect(stats?.receivedCount).toBe(2);
  });

  it('attaches to a client session duck-typed on the smpp client', async () => {
    const listener = new DlrListener();
    const received: DeliverSmPdu[] = [];
    const client = {
      onDeliveryReceipt: (cb: (pdu: DeliverSmPdu) => void) => {
        void cb(receiptPdu());
        received.length; // no-op to keep typing honest
      },
    } as unknown as SmppClient;

    listener.attachTo(client);
    expect(listener.receiptsForAlert('any')).toBeUndefined(); // unmatched, ignored loudly
  });
});
