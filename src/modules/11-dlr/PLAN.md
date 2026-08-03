# Module 11 — Delivery Receipts (DLR) and Feedback

**Status: DESIGNED — DLR listener buildable now; SMSC must emit `deliver_sm`.**

## Purpose (requirement #11)
Listen for real delivery receipts (`deliver_sm` PDUs) and produce an
alert-identifier-wise report: submitted, delivered, failed.

## Design
- `dlr-listener.ts` — hooks the session's `deliver_sm` events (module 07),
  parses the receipt fields (`message_id`, `message_state` → DELIVRD/REJECTD/EXPIRED,
  `err` code), and updates per-message state.
- `dlr-reporter.ts` — aggregates per-alert counters; supports real-time query
  (`GET /api/v1/alerts/:id/report`) and persists to `alert_reports` when DB is
  configured.
- `SMS_REGISTERED_DELIVERY=0x03` (default in .env) requests the SMSC to return
  receipts; flip to 0x01 to disable.

## Real inputs
- SMSC that forwards DLRs (part of module 07 creds).

## Latency instrumentation (cross-cutting)
- On the **first** successful DLR mark `traceStore.mark(capIdentifier, 't4',
  'dlr.first')`.
- On **every** DLR call `traceStore.recordDelivery(capIdentifier, now)` — the
  store derives duration-from-t0 and maintains the distribution that powers the
  50/90/100% percentiles.
- When `deliveredCount >= expectedRecipients` mark `t5` (`'dlr.all_expected'`).
  Note the histogram is maintained per alert; at 10-crore scale a fixed-bucket
  histogram replaces the raw duration list (see `src/tracing/trace-store.ts`).
