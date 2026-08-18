#!/usr/bin/env tsx
const BASE = 'http://127.0.0.1:8080/api/v1';

// Delhi NCR rectangle polygon (closed ring)
const polygon: [number, number][] = [
  [28.88, 76.85],
  [28.88, 77.45],
  [28.40, 77.45],
  [28.40, 76.85],
  [28.88, 76.85],
];

async function main(): Promise<void> {
  console.log('1. POST /alerts/manual');
  const resp = await fetch(`${BASE}/alerts/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      polygon, message: 'Flood — diagnostic test', severity: 'Severe',
      expiresInMinutes: 180, hazardType: 'flood',
    }),
  });
  const text = await resp.text();
  console.log('HTTP', resp.status, text.slice(0, 1500));
  if (resp.status !== 202) process.exit(1);

  const data = JSON.parse(text);
  const capId = data.capIdentifier;
  console.log('capIdentifier:', capId);

  for (let i = 1; i <= 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const r = await fetch(`${BASE}/alerts/${encodeURIComponent(capId)}/pipeline-status`, { signal: AbortSignal.timeout(10000) });
      const b = await r.text();
      console.log(`[poll ${i}] status=${r.status} body=${b.slice(0, 1500)}`);
      if (r.status === 200) {
        const j = JSON.parse(b);
        if (j.status === 'halted' || j.status === 'completed') {
          if (j.reason) console.log('HALT REASON:', j.reason);
          // towers
          try {
            const tr = await fetch(`${BASE}/alerts/${encodeURIComponent(capId)}/towers`, { signal: AbortSignal.timeout(10000) });
            const tb = await tr.text();
            console.log(`towers: HTTP ${tr.status} ${tb.slice(0, 500)}`);
          } catch (e: any) { console.log('towers ERR:', e.message); }
          break;
        }
      }
    } catch (e: any) {
      console.log(`[poll ${i}] ERR:`, e.message);
    }
  }
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
