// ===========================================================================
// TURANT — load test for the CAP ingestion endpoint (requirement #14)
//
// Reads a REAL CAP XML document from disk (set CAP_XML_FILE). It does not embed
// sample payloads. Point it at the real CAP XML the C-DOT EWS emits once you
// have it; until then the run will fail with a clear missing-file error.
//
// Usage:
//   k6 run --env BASE_URL=http://localhost:8080 --env CAP_XML_FILE=./cap.xml cap-ingest.k6.js
//
// Record observed throughput (req/s), p95 latency and error rate under each
// stage for capacity planning conversations with your mentor.
// ===========================================================================

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const CAP_XML_FILE = __ENV.CAP_XML_FILE || './fixtures/cap.xml';

// k6 `open` reads relative to this script's directory.
let capXml;
try {
  capXml = open(CAP_XML_FILE);
} catch (e) {
  // k6 aborts a test if a required input is missing — no fake data fallback.
  throw new Error(`CAP_XML_FILE not found: ${CAP_XML_FILE}. Provide a real CAP XML document from the EWS.`);
}

export const options = {
  stages: [
    { duration: '30s', target: 5 }, // warm-up
    { duration: '30s', target: 50 },
    { duration: '60s', target: 200 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
  },
};

export default function () {
  const res = http.post(`${BASE_URL}/api/v1/alerts/cap`, capXml, {
    headers: { 'Content-Type': 'application/xml' },
    tags: { name: 'ingest_cap' },
  });

  check(res, {
    'status is 202 Accepted': (r) => r.status === 202,
    'alertId present': (r) => {
      try {
        return JSON.parse(r.body).alertId !== undefined;
      } catch {
        return false;
      }
    },
  });

  // Simulated EWS pacing between alerts.
  sleep(0.05);
}
