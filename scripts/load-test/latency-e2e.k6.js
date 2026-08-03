// ===========================================================================
// TURANT — end-to-end LATENCY load test (requirement #14, latency-first)
//
// The number that matters for the mentor demo and production sign-off is not
// messages/sec alone — it is t0 → 90% of intended recipients delivered. This
// script:
//   1. POSTs a REAL CAP XML alert and captures its capIdentifier.
//   2. Polls the latency endpoint until the alert's delivery percentiles
//      appear (server computes them clock-skew-free relative to its own t0).
//   3. Records custom k6 metrics for t0→first/50/90/100% delivered.
//
// Delivery percentiles need SMSC + DLRs (modules 07/11). Until those arrive,
// the script degrades gracefully: after MAX_WAIT_MS it records the server-side
// t0→t3 (submission-complete) duration as a pipeline proxy, tagged so the run
// is not silently misread as delivery latency.
//
// Usage:
//   k6 run \
//     --env BASE_URL=http://localhost:8080 \
//     --env CAP_XML_FILE=./cap.xml \
//     --env MAX_WAIT_MS=30000 \
//     latency-e2e.k6.js
// ===========================================================================

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const CAP_XML_FILE = __ENV.CAP_XML_FILE || './fixtures/cap.xml';
const MAX_WAIT_MS = Number(__ENV.MAX_WAIT_MS || 30000);
const POLL_INTERVAL_MS = Number(__ENV.POLL_INTERVAL_MS || 1000);
const VUS = Number(__ENV.VUS || 1);

let capXml;
try {
  capXml = open(CAP_XML_FILE);
} catch (e) {
  throw new Error(`CAP_XML_FILE not found: ${CAP_XML_FILE}. Provide a real CAP XML document from the EWS.`);
}

// Custom latency metrics — the product metric, not just throughput.
const t0ToFirstDelivery = new Trend('t0_to_first_delivery_ms');
const t0ToP50 = new Trend('t0_to_p50_delivered_ms');
const t0ToP90 = new Trend('t0_to_p90_delivered_ms');
const t0ToP100 = new Trend('t0_to_p100_delivered_ms');
const pipelineProxy = new Trend('pipeline_t0_to_t3_submit_ms');
const pollCount = new Counter('latency_poll_rounds');

export const options = {
  scenarios: {
    latency: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: VUS, // 1 iteration per VU: each iteration is a full alert lifecycle
    },
  },
  thresholds: __ENV.THRESHOLD_P90_MS
    ? { t0_to_p90_delivered_ms: [`p(90)<${__ENV.THRESHOLD_P90_MS}`] }
    : {},
};

function ingestAndTrackTrace() {
  const postRes = http.post(`${BASE_URL}/api/v1/alerts/cap`, capXml, {
    headers: { 'Content-Type': 'application/xml' },
    tags: { name: 'ingest_cap' },
  });
  check(postRes, { 'ingest 202 accepted': (r) => r.status === 202 });

  let capIdentifier;
  try {
    capIdentifier = JSON.parse(postRes.body).capIdentifier;
  } catch (e) {
    throw new Error(`ingest response missing capIdentifier: ${postRes.body}`);
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  let sawPercentiles = false;
  let sawT5 = false;
  let proxyRecorded = false;

  while (Date.now() < deadline) {
    const traceRes = http.get(`${BASE_URL}/api/v1/traces/${encodeURIComponent(capIdentifier)}`, {
      tags: { name: 'trace_poll' },
    });
    if (traceRes.status === 200) {
      const trace = traceRes.json();
      pollCount.add(1);

      if (trace.percentiles && trace.percentiles.p90Ms !== undefined) {
        t0ToFirstDelivery.add(trace.percentiles.firstDeliveryMs);
        t0ToP50.add(trace.percentiles.p50Ms);
        t0ToP90.add(trace.percentiles.p90Ms);
        t0ToP100.add(trace.percentiles.p100Ms);
        sawPercentiles = true;
        break; // delivery latency measured — done for this alert
      }

      if (trace.points && trace.points.t5) sawT5 = true;
    }
    sleep(POLL_INTERVAL_MS / 1000);
  }

  if (!sawPercentiles) {
    // No DLRs yet (SMSC credentials pending). Report the server-side pipeline
    // latency t0→t3 as a clearly-labelled proxy.
    const traceRes = http.get(`${BASE_URL}/api/v1/traces/${encodeURIComponent(capIdentifier)}`, {
      tags: { name: 'trace_final' },
    });
    if (traceRes.status === 200) {
      const trace = traceRes.json();
      const t0 = trace.points && trace.points.t0;
      const t3 = trace.points && trace.points.t3;
      if (t0 && t3) {
        pipelineProxy.add(t3.epochMs - t0.epochMs);
        proxyRecorded = true;
      }
    }
  }

  return { sawPercentiles, sawT5, proxyRecorded };
}

export default function () {
  const { sawPercentiles } = ingestAndTrackTrace();
  if (!sawPercentiles) {
    // eslint-disable-next-line no-console
    console.warn(
      'No delivery percentiles within MAX_WAIT_MS — DLR data pending (SMSC creds). Recorded pipeline proxy t0->t3 instead.',
    );
  }
}
