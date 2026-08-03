import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import { traceStore } from '../../tracing/trace-store.js';
import type { SmsMessage, SubmissionResult } from '../../types/sms.js';
import { getLogger } from '../../utils/logger.js';
import { toSmppValidityPeriod } from '../08-smpp-validity/validity-period.js';
import type { DeliverSmPdu, Session, SubmitSmOptions } from 'smpp';

const logger = getLogger();

/**
 * Real SMSC integration via SMPP — requirement #7.
 *
 * A real SMPP 3.4 client (npm `smpp`, farhadi/node-smpp) with bind lifecycle,
 * submit_sm construction using the real fields from modules 08/09 (validity
 * period, priority flag), automatic reconnect and enquire_link keepalive.
 *
 * Mirrors the HttpTowerSource pattern: fully implemented against the real
 * protocol, but every connection method throws a clear "awaiting credentials"
 * error when SMPP_HOST/SMPP_SYSTEM_ID are not configured — it never fabricates
 * a working connection.
 */

export class SmppClient {
  private session: Session | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closedByUs = false;
  private readonly cfg: ParsedEnvConfig;

  constructor(cfg: ParsedEnvConfig = loadConfig()) {
    this.cfg = cfg;
  }

  /** Whether real SMSC credentials exist to bind against. */
  isConfigured(): boolean {
    return Boolean(this.cfg.SMPP_HOST && this.cfg.SMPP_SYSTEM_ID);
  }

  /**
   * Connect and bind. Throws a clear error until real C-DOT credentials are
   * provided — never a fake session.
   */
  async connect(): Promise<Session> {
    if (!this.isConfigured()) {
      throw new Error(
        'SMPP credentials not configured (SMPP_HOST / SMPP_SYSTEM_ID). Awaiting C-DOT SMSC sandbox credentials.',
      );
    }
    if (this.session) return this.session;

    logger.info({ host: this.cfg.SMPP_HOST, port: this.cfg.SMPP_PORT }, 'smpp.connect');
    const session = (await import('smpp')).default.connect({
      host: this.cfg.SMPP_HOST,
      port: this.cfg.SMPP_PORT,
      connectTimeout: this.cfg.SMPP_SUBMIT_TIMEOUT_MS,
      auto_enquire_link_period: this.cfg.SMPP_ENQUIRE_LINK_PERIOD_MS / 1000,
    });

    await new Promise<void>((resolve, reject) => {
      const bindOpts = {
        system_id: this.cfg.SMPP_SYSTEM_ID,
        password: this.cfg.SMPP_PASSWORD ?? '',
        system_type: this.cfg.SMPP_SYSTEM_TYPE ?? '',
        interface_version: this.cfg.SMPP_INTERFACE_VERSION_NUM,
      };
      const bind = this.cfg.SMPP_BIND_MODE === 'transmitter' ? 'bind_transmitter' : 'bind_transceiver';
      session[bind](bindOpts, (pdu) => {
        if (pdu.command_status === 0) resolve();
        else reject(new Error(`SMPP bind failed with command_status=${pdu.command_status}`));
      });
    });

    this.session = session;
    session.on('close', () => this.handleDisconnect());
    session.on('error', (err) => logger.error({ err }, 'smpp.session_error'));
    logger.info('smpp.bound');
    return session;
  }

  /** Register a delivery-receipt callback (module 11 attaches here). */
  onDeliveryReceipt(cb: (pdu: DeliverSmPdu) => void): void {
    if (!this.session) throw new Error('No active SMPP session; connect() first');
    this.session.on('deliver_sm', (pdu) => cb(pdu as DeliverSmPdu));
  }

  /** Submit one message; resolves to a real SubmissionResult. */
  async submitSingle(message: SmsMessage): Promise<SubmissionResult> {
    const session = await this.connect();
    return this.submitOne(session, message);
  }

  /**
   * Submit a batch with a bounded in-flight window. Marks stage t3 on the
   * shared latency trace once the whole batch's submission completes.
   */
  async submitBatch(messages: readonly SmsMessage[], traceKey?: string): Promise<SubmissionResult[]> {
    const session = await this.connect();
    const results = new Array<SubmissionResult>(messages.length);
    let cursor = 0;

    const worker = async () => {
      while (cursor < messages.length) {
        const idx = cursor++;
        results[idx] = await this.submitOne(session, messages[idx]!);
      }
    };
    const workers = Array.from({ length: Math.min(this.cfg.SMPP_SUBMIT_CONCURRENCY, messages.length) }, () => worker());
    await Promise.all(workers);

    if (traceKey) {
      await traceStore.mark(traceKey, 't3', 'smpp.submit_complete', Date.now());
    }
    return results;
  }

  /** Close the session (cancels pending reconnect). */
  async close(): Promise<void> {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.session) {
      const session = this.session;
      this.session = null;
      await new Promise<void>((resolve) => session.close(() => resolve()));
    }
  }

  private submitOne(session: Session, message: SmsMessage): Promise<SubmissionResult> {
    const pdu = buildSubmitSmPdu(message, this.cfg);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          messageId: message.messageId,
          msisdn: message.msisdn,
          outcome: 'failed',
          errorText: `submit_sm timed out after ${this.cfg.SMPP_SUBMIT_TIMEOUT_MS}ms`,
        });
      }, this.cfg.SMPP_SUBMIT_TIMEOUT_MS);

      session.submit_sm(pdu, (resp) => {
        clearTimeout(timer);
        if (resp.command_status === 0) {
          resolve({
            messageId: message.messageId,
            msisdn: message.msisdn,
            outcome: 'accepted',
            smscMessageId: typeof resp.message_id === 'string' ? resp.message_id : undefined,
          });
        } else {
          resolve({
            messageId: message.messageId,
            msisdn: message.msisdn,
            outcome: 'rejected',
            errorCode: resp.command_status,
            errorText: smppErrorText(resp.command_status),
          });
        }
      });
    });
  }

  private handleDisconnect(): void {
    if (this.closedByUs) return;
    logger.warn({ delayMs: this.cfg.SMPP_RECONNECT_DELAY_MS }, 'smpp.disconnected_scheduling_reconnect');
    this.session = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((err) => logger.error({ err }, 'smpp.reconnect_failed'));
    }, this.cfg.SMPP_RECONNECT_DELAY_MS);
  }
}

/**
 * Build a real submit_sm PDU from a TURANT message + env config (pure — unit
 * tested without a live SMSC). Uses module 08 (validity_period) and module 09
 * (priority_flag) values already on the message. Validity is encoded in UTC
 * (nn = 00) with seconds truncated — the least ambiguous form for an SMSC.
 */
export function buildSubmitSmPdu(message: SmsMessage, cfg: ParsedEnvConfig = loadConfig()): SubmitSmOptions {
  const shortMessage = encodeMessageContent(message.content, message.dataCoding);
  return {
    source_addr_ton: cfg.SMPP_SRC_ADDR_TON,
    source_addr_npi: cfg.SMPP_SRC_ADDR_NPI,
    source_addr: cfg.SMPP_SRC_ADDR ?? '',
    dest_addr_ton: cfg.SMPP_DEST_ADDR_TON,
    dest_addr_npi: cfg.SMPP_DEST_ADDR_NPI,
    destination_addr: message.msisdn,
    esm_class: 0,
    protocol_id: 0,
    priority_flag: message.priorityFlag,
    schedule_delivery_time: undefined,
    validity_period: message.validityPeriod
      ? toSmppValidityPeriod(message.validityPeriod, { timezoneOffsetMinutes: 0, truncateSeconds: true })
      : undefined,
    registered_delivery: message.registeredDelivery,
    replace_if_present_flag: 0,
    data_coding: message.dataCoding === 'ucs2' ? 8 : 0,
    sm_default_msg_id: 0,
    short_message: shortMessage,
  };
}

/** Validate content length for the target coding; fail loudly, never truncate. */
export function encodeMessageContent(content: string, dataCoding: '7bit' | 'ucs2'): string {
  const maxChars = dataCoding === 'ucs2' ? 70 : 160;
  if (content.length === 0) throw new Error('SMS content must not be empty');
  if (content.length > maxChars) {
    throw new Error(`SMS content is ${content.length} characters; exceeds ${maxChars} for ${dataCoding} coding. Early-warning messages must fit one SMS.`);
  }
  return content;
}

const COMMAND_STATUS: Record<number, string> = {
  0: 'ESME_ROK',
  4: 'ESME_RINVMSGLEN',
  5: 'ESME_RINVCMDLEN',
  8: 'ESME_RINVSRCADR',
  0xa: 'ESME_RINVDSTADR',
  0xb: 'ESME_RINVMSGID',
  0xc: 'ESME_RBINDFAIL',
  0xd: 'ESME_RINVPASWD',
  0xe: 'ESME_RINVSYSID',
  0x11: 'ESME_RINVSRCTON',
  0x12: 'ESME_RINVSRCNPI',
  0x13: 'ESME_RINVDSTTON',
  0x14: 'ESME_RINVDSTNPI',
  0x400: 'ESME_RTHROTTLED',
  0x401: 'ESME_RINVSCHED',
  0x402: 'ESME_RINVEXPIRY',
  0x403: 'ESME_RINVDFTMSGID',
  0x404: 'ESME_RX_T_APPN',
  0x405: 'ESME_RX_P_APPN',
  0x406: 'ESME_RX_R_APPN',
  0x408: 'ESME_RQUERYFAIL',
  0x409: 'ESME_RINVOPTPARSTREAM',
};

export function smppErrorText(commandStatus: number | undefined): string {
  if (commandStatus === undefined) return 'command_status not present';
  return COMMAND_STATUS[commandStatus] ?? `command_status=${commandStatus}`;
}
