import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import { SmppClient } from './smpp-client.js';

/**
 * Shared SMPP session lifecycle for the process (module 07).
 *
 * One SmppClient per process, lazily connected. The orchestrator and the DLR
 * listener both bind to the same session so submit_sm and deliver_sm share a
 * single SMSC connection.
 *
 * `createSmppClient` is the single construction point so tests can inject a
 * fake client (see `setSmppClientFactoryForTests`) without touching the real
 * SMSC.
 */

let shared: SmppClient | null = null;
let clientFactory: ((cfg: ParsedEnvConfig) => SmppClient) | null = null;

/** Build a SmppClient for the given config (honors the test factory). */
export function createSmppClient(cfg: ParsedEnvConfig = loadConfig()): SmppClient {
  if (clientFactory) return clientFactory(cfg);
  return new SmppClient(cfg);
}

/** Get the process-wide SMPP client (lazy; does not connect until used). */
export function getSmppSession(cfg: ParsedEnvConfig = loadConfig()): SmppClient {
  if (clientFactory) return clientFactory(cfg);
  if (!shared) shared = new SmppClient(cfg);
  return shared;
}

/** Test hook: inject a fake client factory (set null to restore). */
export function setSmppClientFactoryForTests(fn: ((cfg: ParsedEnvConfig) => SmppClient) | null): void {
  clientFactory = fn;
}

/** Test hook: drop the shared client and any factory so a fresh one is built. */
export function resetSmppSessionForTests(): void {
  shared = null;
  clientFactory = null;
}
