import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import { SmppClient } from './smpp-client.js';

/**
 * Shared SMPP session lifecycle for the process (module 07).
 *
 * One SmppClient per process, lazily connected. The orchestrator and the DLR
 * listener both bind to the same session so submit_sm and deliver_sm share a
 * single SMSC connection.
 */

let shared: SmppClient | null = null;

/** Get the process-wide SMPP client (lazy; does not connect until used). */
export function getSmppSession(cfg: ParsedEnvConfig = loadConfig()): SmppClient {
  if (!shared) shared = new SmppClient(cfg);
  return shared;
}

/** Test hook: drop the shared client so a fresh one is built. */
export function resetSmppSessionForTests(): void {
  shared = null;
}
