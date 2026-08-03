# Module 09 — Priority Flagging

**Status: DESIGNED — buildable now.**

## Purpose (requirement #9)
Set the SMPP `priority_flag` to the highest value for every early-warning
message, so the SMSC queues them ahead of normal traffic.

## Design
- `priority.ts` — single source of truth mapping TURANT priority levels to SMPP
  `priority_flag` (0 normal … 3 highest). Early-warning alerts always map to 3.
- Consumed by the `submit_sm` PDU builder in module 07.

## Real inputs
- None new.

## Latency instrumentation (cross-cutting)
- No t-mark here. `priority_flag=3` exists to *shrink* `t2 → t3 → t4`: higher
  priority shortens SMSC queue dwell, which is exactly what the latency report
  is built to surface.
