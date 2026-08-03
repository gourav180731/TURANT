# Module 07 — Real SMSC Integration via SMPP

**Status: DESIGNED — library selected, connection point marked `AWAITING
CREDENTIALS`. C-DOT SMSC sandbox credentials not yet received.**

## Purpose (requirement #7)
Real SMPP 3.4 client (not a mock) that binds to and submits to an actual SMSC.
Supports `submit_sm` (single) and file/batch submission.

## Library selection
`smpp` (github.com/farhadi/node-smpp, npm `smpp@0.6.0-rc.4`) — the de-facto
production SMPP implementation for Node.js: full SMPP 3.4 PDU codec,
`bind_transceiver`, `submit_sm`, `deliver_sm` (DLR) and reconnect management.
TURANT does not hand-roll the protocol. Ambient types live in
`src/types/smpp.d.ts`.

## Design
- `smpp-client.ts` — connection + bind lifecycle with automatic reconnect
  (`SMPP_RECONNECT_DELAY_MS`), `enquire_link` keepalive, and per-submit
  `submit_sm` with the real `command_status` surfaced on every result.
- `smpp-session.ts` — bind mode (transceiver/transmitter), interface version,
  address TON/NPI.
- `batch-submitter.ts` — file-based submission path (bulk MSISDN files) for the
  batch/file mode.

## Real inputs required from C-DOT (AWAITING)
- `SMPP_HOST`, `SMPP_PORT`, `SMPP_SYSTEM_ID`, `SMPP_PASSWORD`,
  `SMPP_SYSTEM_TYPE` (sandbox or production).
- Confirm `SMPP_SRC_ADDR` (registered SMS header) and TON/NPI conventions.

## Latency instrumentation (cross-cutting)
- After the last `submit_sm` of a batch returns, mark
  `traceStore.mark(capIdentifier, 't3', 'smpp.submit_complete')`.
- Per-batch `submit_sm` latency (µs/msg and ms/1k) logged as
  `smpp.submit.batch` so the `t2 → t3` delta is attributable to SMSC throughput,
  not TURANT overhead.
