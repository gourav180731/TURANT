package com.turant.types.trace;

/**
 * Per-alert latency trace stages.
 * 
 * Stage contract (cross-cutting, applies to every module):
 *   t0 — CAP XML received/ingested (module 01)
 *   t1 — Cell site identification complete (module 02)
 *   t2 — Subscriber matching complete, post-dedup (modules 03, 04, 05)
 *   t3 — SMPP submission complete for the batch (modules 06, 09, 10)
 *   t4 — First delivery receipt (DLR) received (module 11)
 *   t5 — All expected DLRs received, or alert expiry (modules 06, 08)
 */
public enum TraceStage {
    t0,
    t1,
    t2,
    t3,
    t4,
    t5
}
