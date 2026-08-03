# Module 08 — SMSC-Side Validity Enforcement

**Status: DESIGNED — buildable now; exercised once SMSC creds arrive.**

## Purpose (requirement #8)
Set the SMPP `validity_period` on every submitted message so the SMSC itself
will not deliver an alert after expiry.

## Design
- `validity-period.ts` — converts the CAP `expires` timestamp (module 01) into
  the SMPP absolute validity_period format
  (`YYMMDDhhmmsstnnp` — e.g. `25080112000000000R`, `R` = relative / `000R` by
  convention per SMPP 3.4).
- Applied inside the `submit_sm` PDU build in module 07; a small `VALIDITY_LEAD`
  margin truncates to SMSC-acknowledged delivery window.
- Verified end-to-end only when a real SMSC is reachable.

## Real inputs
- None new — CAP `expires` + SMPP creds (module 07).

## Latency instrumentation (cross-cutting)
- `validity_period` bounds SMSC-side delivery: anything past it becomes a DLR
  with state EXPIRED. Module 11 feeds those back as `recordDelivery` outcomes so
  the percentiles reflect only in-window deliveries. No separate t-mark here.
