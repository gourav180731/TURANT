// ===========================================================================
// TURANT — load test for the telecom simulation's subscriber-matching path
//
// Exercises the FULL pipeline against the simulated subscriber database:
// POST a CAP alert, poll the per-alert pipeline-status endpoint until the run
// settles, and assert that module 02 resolved towers, modules 03/04 matched
// real (simulated) recipients, and the dissemination leg completed.
//
// Requires the app to be booted with the sim enabled:
//   USE_DUMMY_SUBSCRIBER_DB=true SUBSCRIBER_DB_MODE=memory DUMMY_TOWER_COUNT=...
//
// Usage:
//   k6 run --env BASE_URL=http://localhost:8080 \
//          --env CAP_XML_FILE=./cap-delhi-ncr.xml subscriber-lookup.k6.js
//
// Record matched-recipients/s and p95 end-to-end (ingest → status) under each
// stage for the capacity-planning conversation.
// ===========================================================================

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const CAP_XML_FILE = __ENV.CAP_XML_FILE || './cap-delhi-ncr.xml';
const POLL_INTERVAL_MS = __ENV.POLL_INTERVAL_MS || 100;
const SETTLE_DEADLINE_MS = __ENV.SETTLE_DEADLINE_MS || 10000;

let capXml;
try {
  capXml = open(CAP_XML_FILE);
} catch (e) {
  throw new Error(`CAP_XML_FILE not found: ${CAP_XML_FILE}. Provide a CAP XML covering the simulated region (e.g. cap-delhi-ncr.xml).`);
}

export const options = {
  stages: [
    { duration: '30s', target: 5 },  // warm-up
    { duration: '30s', target: 25 },
    { duration: '60s', target: 100 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
  },
};

function pollStatus(statusUrl) {
  const deadline = Date.now() + Number(SETTLE_DEADLINE_MS);
  let last;
  while (Date.now() < deadline) {
    const res = http.get(`${BASE_URL}${statusUrl}`, { tags: { name: 'pipeline_status' } });
    if (res.status !== 200) return { error: `status endpoint returned ${res.status}` };
    last = res.json();
    if (last.status === 'completed' || last.status === 'halted') return last;
    sleep(Number(POLL_INTERVAL_MS) / 1000);
  }
  return { error: 'did not settle in time', last };
}

export default function () {
  const post = http.post(`${BASE_URL}/api/v1/alerts/cap`, capXml, {
    headers: { 'Content-Type': 'application/xml' },
    tags: { name: 'ingest_cap' },
  });

  const accepted = post.status === 202;
  let parsed = {};
  try {
    parsed = JSON.parse(post.body);
  } catch {
    /* keep {} */
  }

  const settled = accepted ? pollStatus(parsed.pipeline && parsed.pipeline.statusUrl) : {};

  check(settled, {
    'ingest accepted (202)': () => accepted,
    'pipeline settled as completed': () => settled.status === 'completed',
    'resolved > 0 towers': () => (settled.towerCount || 0) > 0,
    'matched > 0 recipients': () => (settled.expectedRecipients || 0) > 0,
  });

  sleep(0.05);
}
