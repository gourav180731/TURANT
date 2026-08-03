# Module 06 — Expiry-Aware Submission Control

**Status: DESIGNED — pure time logic, buildable independently.**

## Purpose (requirement #6)
Before submitting each batch to the SMSC, check the CAP alert's real `expires`
timestamp; the moment it is reached, halt all further submission.

## Design
- `expiry-guard.ts` — a tiny stateful guard seeded with `expiresAt` parsed by
  module 01 (`capTiming`). Exposes `canSubmit(batchSize)` and `elapsed()`.
- Every batch (module 13) calls `guard.canSubmit()` first; on `false` the
  pipeline logs `submit.halt_expired` and the remaining MSISDNs are counted as
  `expiredMessageCount`.
- `EXPIRY_HALT_SUBMISSION=true` (default) enables hard halt.
- A pre-validity window (`VALIDITY_LEAD_MARGIN_MS`) protects against clock
  skew between TURANT and the SMSC.

## Real inputs
- None new — uses the CAP `expires` field.

## Latency instrumentation (cross-cutting)
- When the guard halts submission at expiry, mark
  `traceStore.mark(capIdentifier, 't5', 'alert.expiry', now)` — this is one of
  the two legitimate t5 conditions ("all expected DLRs received, or alert expiry
  reached, whichever first"). The other is module 11 (all DLRs in).
- Every rejected batch logs `submit.halt_expired` with the count added to
  `expiredMessageCount`.
