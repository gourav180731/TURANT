# Module 05 — Duplicate Elimination

**Status: DESIGNED — pure in-memory logic, buildable independently.**

## Purpose (requirement #5)
Remove duplicate MSISDNs (a subscriber can appear under several towers) before
SMS submission, in-memory, without adding meaningful latency.

## Design
- `dedupe.ts` — a single pass over the matched list inserting into a `Set` of
  E.164 MSISDNs; O(n), sub-second for tens of millions of strings.
- Returns the deduplicated array + the removed-duplicate count (logged for audit).
- Guaranteed stable order-preserving pass so audit counts reconcile.

## Real inputs
- None new — consumes module 04 output.

## Latency instrumentation (cross-cutting)
- After dedup: `traceStore.setExpectedRecipients(capIdentifier, deduped.length)`
  then `traceStore.mark(capIdentifier, 't2', 'subscriber.match+dedup')`.
- `expectedRecipients` is the denominator for the 50/90/100% delivery
  percentiles in module 11 and the EWS callback (module 12).
