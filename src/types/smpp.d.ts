/**
 * Ambient declarations for the `smpp` package (farhadi/node-smpp), the
 * production-standard SMPP 3.4 implementation for Node.js.
 *
 * The package ships no bundled typings and is CJS (`module.exports = ...`);
 * this declaration mirrors the real API surface used by TURANT. The library
 * auto-encodes string `short_message` from the `data_coding` field (ASCII =
 * GSM-7 / 7-bit, UCS2 = utf16-be), so callers pass plain text.
 */

declare module 'smpp' {
  import type { EventEmitter } from 'node:events';

  export interface SessionOptions {
    host?: string;
    port?: number;
    debug?: boolean;
    connectTimeout?: number;
    auto_enquire_link_period?: number;
  }

  export interface BindOptions {
    system_id?: string;
    password?: string;
    system_type?: string;
    interface_version?: number;
    addr_ton?: number;
    addr_npi?: number;
    address_range?: string;
  }

  /** Fields used by TURANT for submit_sm (modules 07/08/09). */
  export interface SubmitSmOptions {
    source_addr_ton?: number;
    source_addr_npi?: number;
    source_addr?: string;
    dest_addr_ton?: number;
    dest_addr_npi?: number;
    destination_addr?: string;
    esm_class?: number;
    protocol_id?: number;
    priority_flag?: number;
    schedule_delivery_time?: string;
    validity_period?: string;
    registered_delivery?: number;
    replace_if_present_flag?: number;
    data_coding?: number;
    sm_default_msg_id?: number;
    short_message?: string | Buffer;
  }

  export interface Pdu {
    command?: string;
    command_id?: number;
    command_status?: number;
    sequence_number?: number;
    message_id?: string;
    message?: string;
    [key: string]: unknown;
  }

  /** deliver_sm PDU as received by TURANT's DLR listener (module 11). */
  export interface DeliverSmPdu extends Pdu {
    source_addr?: string;
    destination_addr?: string;
    short_message?: { message?: string | Buffer; udh?: Buffer; [k: string]: unknown } | string | Buffer;
    message_state?: number;
  }

  export interface Session extends EventEmitter {
    bind_transceiver(opts?: BindOptions, cb?: (pdu: Pdu) => void): void;
    bind_transmitter(opts?: BindOptions, cb?: (pdu: Pdu) => void): void;
    bind_receiver(opts?: BindOptions, cb?: (pdu: Pdu) => void): void;
    submit_sm(opts: SubmitSmOptions, cb?: (pdu: Pdu) => void): void;
    deliver_sm(opts?: unknown, cb?: (pdu: Pdu) => void): void;
    enquire_link(cb?: (pdu: Pdu) => void): void;
    send(pdu: Record<string, unknown>): void;
    close(cb?: () => void): void;
    destroy(cb?: () => void): void;
  }

  export function connect(opts: SessionOptions, listener?: () => void): Session;

  export interface Encoding {
    encode(value: string): string | Buffer;
    decode(value: string | Buffer): string;
  }

  export const encodings: {
    ASCII: Encoding;
    LATIN1: Encoding;
    UCS2: Encoding;
  };

  const smpp: {
    connect: typeof connect;
    Session: { new (opts?: SessionOptions): Session };
    encodings: typeof encodings;
  };

  export default smpp;
}
