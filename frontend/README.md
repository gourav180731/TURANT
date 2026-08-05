# TURANT · Polygon Alert Console (demo UI)

A minimal single-page map console for the TURANT early-warning backend: draw a
polygon, fill in the alert, hit **Send Alert**, and watch the real pipeline
advance from tower resolution → subscriber matching → dedup → submission.

Everything you see is real: there is **no mock data** anywhere in this app.
Every number in the results panel comes from a live TURANT API response
(see `src/api.ts`), and the backend itself only reports what the pipeline
actually did.

## Requirements

- Node 18+ (the backend runs on Node 18+; the Vite dev server works on any).
- The TURANT backend running on `http://127.0.0.1:8080` (default `PORT` from root `.env`).
  See the repository root README for how to boot it.

## Run

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

`vite.config.ts` proxies `/api/*` to `http://127.0.0.1:8080`, so the browser
talks to the real backend. Change the `target` there if your backend runs on a
different port.

Production build (used by CI / `npm run build`):

```bash
npm run build      # tsc --noEmit && vite build → dist/
npm run preview    # serve the production bundle
```

## How to use it

1. **Draw a polygon** with the blue polygon tool on the map. The faint grey
   circles are the configured city-cluster hints (see below).
2. Fill in the message, severity, optional hazard type and expiry window.
3. **Send Alert** → `POST /api/v1/alerts/manual`. The backend synthesizes a
   real CAP 1.2 document from your polygon and runs the same pipeline the CAP
   XML endpoint uses.
4. The panel polls the pipeline-status endpoint every ~1s until the run halts
   or completes, then fetches the real matched-tower markers (rendered as red
   dots) and the real DLR delivery report.

## Backend notes

- Set **`USE_DUMMY_SUBSCRIBER_DB=true`** (and `SUBSCRIBER_DB_MODE=memory`) so
  the simulated subscriber network is booted in-process. Without it the
  pipeline still runs but halts at subscriber-matching — which the console
  shows honestly ("halted — no fabrication").
- Set **`SIM_REGION=india`** for all 18 city clusters (Delhi NCR, Jaipur,
  Lucknow, Mumbai, Pune, Ahmedabad, Surat, Bangalore, Chennai, Hyderabad,
  Kochi, Kolkata, Patna, Bhubaneswar, Guwahati, Bhopal, Indore, Nagpur).
  The default (`delhi-ncr`) draws only the single Delhi NCR hint circle, and
  towers exist only in that region.

  **Limitation:** the 18-cluster pan-India expansion means towers/subscribers
  are generated around those 18 city centroids only — not a nationwide
  coverage grid. Drawing a polygon far from a cluster will match zero towers,
  which the pipeline reports truthfully.
- `GET /api/v1/sim/clusters` drives the hint circles; `GET
  /api/v1/alerts/:capIdentifier/towers` drives the matched-tower markers;
  `GET /api/v1/alerts/:capIdentifier/report` drives the delivered count (0
  unless real SMPP credentials + DLR receipts are present).

## Endpoints used

| Purpose | Method + path |
| --- | --- |
| City-cluster hints | `GET /api/v1/sim/clusters` |
| Dispatch a manual alert | `POST /api/v1/alerts/manual` |
| Pipeline progress / halt | `GET /api/v1/alerts/:capIdentifier/pipeline-status` |
| Matched tower markers | `GET /api/v1/alerts/:capIdentifier/towers` |
| Delivery report (real DLR) | `GET /api/v1/alerts/:capIdentifier/report` |
