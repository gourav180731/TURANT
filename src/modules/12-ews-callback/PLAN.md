# Module 12 — Processing Completion Feedback to Source EWS

**Status: DESIGNED — awaiting C-DOT EWS callback URL + token.**

## Purpose (requirement #12)
Report processing completion back to the originating Early Warning System:
processing start/end time, targeted subscriber count, SMS count, successful push
count, expired message count.

## Contract (posted to `EWS_CALLBACK_URL`, `Authorization: Bearer EWS_CALLBACK_TOKEN`)
```json
{
  "alertId": "uuid",
  "capIdentifier": "sender:identifier",
  "processingStartedAt": "ISO",
  "processingEndedAt": "ISO",
  "targetedSubscriberCount": 123456,
  "smsSubmittedCount": 123456,
  "smsAcceptedCount": 123456,
  "deliveredCount": 110000,
  "failedCount": 100,
  "expiredMessageCount": 0,
  "successfulPushCount": 123456,
  "towerCount": 4123,
  "completed": true
}
```

## Consistency rule (requirement #12)
`successfulPushCount === smsSubmittedCount`. A message is "submitted" when the
SMSC accepts it (`submit_sm` command_status 0); `smsAcceptedCount` is that same
number. Delivered/failed come from DLRs and are reported alongside, but never
change the submitted/successful pair. This is enforced by the report builder.

## Design
- `ews-callback.ts` — fire-and-forget POST with timeout + retry, written to the
  audit log and `alert_reports` table for replay.

## Real inputs
- `EWS_CALLBACK_URL`, `EWS_CALLBACK_TOKEN`.

## Latency instrumentation (cross-cutting)
- Include `latencyMs` (`t0ToFirstDeliveryMs`, `t0ToP50Ms`, `t0ToP90Ms`,
  `t0ToP100Ms`) in the completion payload — populated from the trace store
  (`src/types/report.ts` + `src/types/trace.ts`). This is what the EWS and the
  mentor demo actually evaluate: not raw throughput, but t0→90% delivered.
