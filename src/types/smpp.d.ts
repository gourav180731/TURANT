/**
 * Ambient declarations for the `smpp` package (farhadi/node-smpp), the
 * production-standard SMPP 3.4 implementation for Node.js.
 *
 * The package ships no bundled typings; this module is kept minimal and is
 * consumed by module 07 (SMSC integration), module 11 (DLR listener), etc.
 */

declare module 'smpp' {
  import type { EventEmitter } from 'node:events';

  export interface SessionOptions {
    host?: string;
    port?: number;
    debug?: boolean;
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

  /** Fields used by TURANT for submit_sm (module 07/08/09). */
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

  export interface DeliverSmPdu extends Pdu {
    source_addr?: string;
    destination_addr?: string;
    short_message?: { message?: string; [k: string]: unknown };
  }

  export interface Session extends EventEmitter {
    bind_transceiver(opts?: BindOptions, cb?: (pdu: Pdu) => void): void;
    bind_transmitter(opts?: BindOptions, cb?: (pdu: Pdu) => void): void;
    submit_sm(opts: SubmitSmOptions, cb?: (pdu: Pdu) => void): void;
    deliver_sm(opts?: unknown, cb?: (pdu: Pdu) => void): void;
    enquire_link(cb?: (pdu: Pdu) => void): void;
    send(pdu: Record<string, unknown>): void;
    close(cb?: () => void): void;
  }

  export function connect(opts: SessionOptions): Session;

  export const encodings: {
    gsm0338: {
      encode(text: string, fallback?: string): string;
      decode(data: string): string;
    };
  };
}
