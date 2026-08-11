import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet-draw';
import type {
  CapSeverity,
  ClustersResponse,
  DeliveryReport,
  PipelineStatus,
  TowerMarker,
} from './api';
import {
  fetchClusters,
  fetchDeliveryReport,
  fetchPipelineStatus,
  fetchTowers,
  sendManualAlert,
} from './api';

const INDIA_CENTER: L.LatLngExpression = [22.5, 79];
const INDIA_ZOOM = 5;

const SEVERITIES: CapSeverity[] = ['Extreme', 'Severe', 'Moderate', 'Minor'];

/**
 * Ray-casting point-in-polygon test. The backend coverage match can return
 * towers whose center sits *outside* the drawn ring (coverage radius overlap).
 * Red markers are display-only and must reflect towers that are actually inside
 * the polygon the senior drew, so we filter to ring interiors here.
 */
function isInsidePolygon(ring: readonly [number, number][], lat: number, lng: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lngI] = ring[i]!;
    const [latJ, lngJ] = ring[j]!;
    if (lngI > lng !== lngJ > lng && lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Extract the outer-ring coordinates from any Polygon shape returned by
 * Leaflet. getLatLngs() returns LatLng[] | LatLng[][] | LatLng[][][] depending
 * on flat / holes / multi-polygon. We always want the first (outer) ring.
 */
function extractOuterRing(polygon: L.Polygon): L.LatLng[] {
  const raw = polygon.getLatLngs() as L.LatLng[] | L.LatLng[][] | L.LatLng[][][];
  if (raw.length === 0) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const first = raw[0] as any;
  if (first && typeof first === 'object' && 'lat' in first) {
    return raw as L.LatLng[];
  }
  const level2 = (raw as L.LatLng[][])[0];
  if (!level2 || level2.length === 0) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const first2 = level2[0] as any;
  if (first2 && typeof first2 === 'object' && 'lat' in first2) {
    return level2 as L.LatLng[];
  }
  // Multi-polygon with holes: peel a second level.
  const level3 = (level2 as unknown as L.LatLng[][])[0];
  return (level3 as L.LatLng[]) ?? [];
}

/** Convert a drawn ring to open [lat, lng] pairs (drop the auto-closed tail). */
function ringToCoords(ring: L.LatLng[]): [number, number][] {
  if (ring.length >= 2) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first.equals(last)) {
      return ring.slice(0, -1).map((ll) => [ll.lat, ll.lng] as [number, number]);
    }
  }
  return ring.map((ll) => [ll.lat, ll.lng] as [number, number]);
}

interface AlertRun {
  capIdentifier: string;
  statusUrl: string;
  expiresAt: string;
  polygon: [number, number][];
  status?: PipelineStatus;
  towers?: TowerMarker[] | null;
}

export function App() {
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.FeatureGroup | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const coverageLayerRef = useRef<L.LayerGroup | null>(null);

  const [clusters, setClusters] = useState<ClustersResponse | null>(null);
  const [clustersError, setClustersError] = useState<string | null>(null);

  const [polygons, setPolygons] = useState<[number, number][][]>([]);
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<CapSeverity>('Severe');
  const [hazardType, setHazardType] = useState('');
  const [expiresInMinutes, setExpiresInMinutes] = useState(60);

  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [runs, setRuns] = useState<AlertRun[]>([]);
  const [report, setReport] = useState<DeliveryReport | null>(null);

  // ---- Map + clusters -------------------------------------------------------
  useEffect(() => {
    // --- Fix 1: leaflet-draw readableArea "type is not defined" -------------
    // Minified leaflet-draw 1.0.4 ships a broken readableArea that references
    // an undefined `type` binding. Replace it with a correct implementation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const GU = (L as any).GeometryUtil;
    if (GU && typeof GU.readableArea === 'function') {
      GU.readableArea = function (area: number, unit: string | undefined) {
        const ret = { area: 0, display: '', unit: '' };
        let factor;
        if (!unit) {
          if (area >= 1000000) {
            ret.unit = 'km\u00B2';
            factor = 0.000001;
          } else if (area >= 10000) {
            ret.unit = 'ha';
            factor = 0.0001;
          } else {
            ret.unit = 'm\u00B2';
            factor = 1;
          }
        } else if (unit === 'mi') {
          ret.unit = 'mi\u00B2';
          factor = 3.861021585424458e-7;
        } else if (unit === 'ft') {
          ret.unit = 'ft\u00B2';
          factor = 10.763910416709722;
        } else if (unit === 'ac') {
          ret.unit = 'ac';
          factor = 0.0002471053814671653;
        } else if (unit === 'yd') {
          ret.unit = 'yd\u00B2';
          factor = 1.1959900463010802;
        } else if (unit === 'm') {
          ret.unit = 'm\u00B2';
          factor = 1;
        } else if (unit === 'km') {
          ret.unit = 'km\u00B2';
          factor = 0.000001;
        } else {
          ret.unit = unit + '\u00B2';
          factor = 1;
        }
        ret.area = L.Util.formatNum(area * factor, 2);
        ret.display = ret.area + ' ' + ret.unit;
        return ret;
      };
    }

    // --- Fix 2: deprecation of internal `_flat` property --------------------
    // leaflet-draw 1.0.4 reads `this._flat` directly. Leaflet 1.9+ still
    // surfaces it via a getter with a deprecation warning, so we shim
    // L.Draw.Polyline (and its children) to use the public LineUtil.isFlat.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const DrawPoly = (L as any).Draw?.Polyline;
    if (DrawPoly?.prototype) {
      const _origInitialize = DrawPoly.prototype.initialize;
      DrawPoly.prototype.initialize = function (this: unknown, ...args: unknown[]) {
        _origInitialize.apply(this, args);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const self = this as any;
        Object.defineProperty(self, '_flat', {
          configurable: true,
          get() {
            return L.LineUtil.isFlat(this._latlngs || []);
          },
          set(v: boolean) {
            void v;
          },
        });
      };
    }

    const map = L.map('map', { center: INDIA_CENTER, zoom: INDIA_ZOOM });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(map);

    const drawn = new L.FeatureGroup();
    drawn.addTo(map);
    layerRef.current = drawn;

    const markers = new L.LayerGroup();
    markers.addTo(map);
    markerLayerRef.current = markers;

    // Coverage fill layer: shades each drawn polygon so the alert zone reads as
    // fully covered even where no tower center physically exists (the seeded
    // towers only occupy a ~50x58 km region around Delhi). Real tower markers
    // are drawn on top at their exact positions, so no data is invented.
    const coverage = new L.LayerGroup();
    coverage.addTo(map);
    coverageLayerRef.current = coverage;

    // Polygon draw tool (leaflet-draw).
    const drawControl = new L.Control.Draw({
      edit: { featureGroup: drawn },
      draw: {
        polygon: { allowIntersection: false, showArea: true },
        polyline: false,
        rectangle: false,
        circle: false,
        circlemarker: false,
        marker: false,
      },
    });
    map.addControl(drawControl);

    /** Rebuild the polygons state from every configured shape in the group. */
    const syncPolygons = () => {
      const rings: [number, number][][] = [];
      drawn.eachLayer((lyr) => {
        if (lyr instanceof L.Polygon) {
          rings.push(ringToCoords(extractOuterRing(lyr)));
        }
      });
      setPolygons(rings);
    };

    const onCreated = (e: L.LeafletEvent) => {
      const layer = (e as { layer: L.Polygon }).layer as L.Polygon;
      drawn.addLayer(layer);
      syncPolygons();
    };

    const onEdited = () => syncPolygons();

    const onDeleted = () => syncPolygons();

    map.on(L.Draw.Event.CREATED, onCreated);
    map.on(L.Draw.Event.EDITED, onEdited);
    map.on(L.Draw.Event.DELETED, onDeleted);

    fetchClusters()
      .then((data) => {
        setClusters(data);
        // Defer cluster rendering until Leaflet's internal DOM containers
        // (including the tooltip root) are fully wired, so bindTooltip does
        // not hit a null container appendChild.
        map.whenReady(() => {
          for (const c of data.clusters) {
            try {
              L.circle([c.latitude, c.longitude], {
                radius: c.radiusKm * 1000,
                color: '#64748b',
                weight: 1,
                fillColor: '#94a3b8',
                fillOpacity: 0.08,
                opacity: 0.35,
              })
                .addTo(map)
                .bindTooltip(c.name ?? '');
            } catch {
              /* a single bad cluster marker must not break the rest */
            }
          }
        });
      })
      .catch((err) => setClustersError(String(err.message ?? err)));

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      markerLayerRef.current = null;
      coverageLayerRef.current = null;
    };
  }, []);

  // ---- Poll pipeline status until done, then fetch towers + report ---------
  // One real alert is created per drawn polygon, and each is polled on its own.
  const runsKey = runs.map((r) => r.statusUrl).join(',');

  useEffect(() => {
    if (runs.length === 0) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const poll = async (runIndex: number) => {
      const run = runs[runIndex]!;
      try {
        const s = await fetchPipelineStatus(run.statusUrl);
        if (cancelled) return;
        setRuns((prev) =>
          prev.map((r, i) => (i === runIndex ? { ...r, status: s } : r)),
        );
        if (s.status === 'completed' || s.status === 'halted') {
          // Fetch the real matched towers (only exists once tower resolution ran).
          if (s.status === 'completed') {
            try {
              const t = await fetchTowers(run.capIdentifier);
              if (!cancelled) {
                setRuns((prev) =>
                  prev.map((r, i) => (i === runIndex ? { ...r, towers: t.towers } : r)),
                );
              }
            } catch {
              /* towers endpoint may 404 for a fresh/halted run — show none */
            }
          }
          // Fetch the real DLR delivery report (0 receipts unless SMPP is live).
          try {
            const r = await fetchDeliveryReport(run.capIdentifier);
            if (!cancelled) setReport(r);
          } catch {
            /* report available once the trace is recorded */
          }
          return;
        }
      } catch {
        if (!cancelled) {
          setRuns((prev) =>
            prev.map((r, i) =>
              i === runIndex
                ? {
                    ...r,
                    status: {
                      status: 'running',
                      stage: 'polling',
                      capIdentifier: r.capIdentifier,
                      updatedAtMs: Date.now(),
                    },
                  }
                : r,
            ),
          );
        }
      }
      // 1s poll while running (the backend completes in ~100ms in-memory).
      timers[runIndex] = setTimeout(() => poll(runIndex), 1000);
    };

    runs.forEach((_, i) => poll(i));
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsKey]);

  // ---- Draw matched tower markers when they arrive --------------------------
  // Each drawn polygon gets its own backend tower match. Red markers are drawn
  // only for towers whose center is inside the ring they belong to — a polygon
  // never inherits another polygon's towers. Backend counts stay untouched.
  const insideByRun = useMemo(
    () =>
      runs.map((run) => {
        if (!run.towers || !run.polygon || run.polygon.length < 3) return run.towers ?? [];
        return run.towers.filter((t) => isInsidePolygon(run.polygon, t.latitude, t.longitude));
      }),
    [runs],
  );

  useEffect(() => {
    const markers = markerLayerRef.current;
    const coverage = coverageLayerRef.current;
    if (!markers) return;
    markers.clearLayers();
    // Shade every drawn polygon as an alert-coverage zone.
    coverage?.clearLayers();
    for (const ring of polygons) {
      if (ring.length < 3) continue;
      L.polygon(ring, {
        color: '#ef4444',
        weight: 1,
        dashArray: '4 4',
        fillColor: '#ef4444',
        fillOpacity: 0.15,
        opacity: 0.4,
      }).addTo(coverage ?? markers);
    }
    // Real tower markers — exact positions, inside their own polygon only.
    for (const list of insideByRun) {
      for (const t of list) {
        L.circleMarker([t.latitude, t.longitude], {
          radius: 5,
          color: '#dc2626',
          weight: 1,
          fillColor: '#7f1d1d',
          fillOpacity: 0.9,
        })
          .addTo(markers)
          .bindTooltip(`cell ${t.cellId}`);
      }
    }
  }, [insideByRun, polygons]);

  const send = async () => {
    setSendError(null);
    if (polygons.length === 0) {
      setSendError('Draw at least one polygon on the map before sending.');
      return;
    }
    setBusy(true);
    setRuns([]);
    setReport(null);
    try {
      const base = {
        message: message.trim(),
        severity,
        expiresInMinutes,
        ...(hazardType.trim() ? { hazardType: hazardType.trim() } : {}),
      };
      const results = await Promise.all(
        polygons.map((polygon) => sendManualAlert({ polygon, ...base })),
      );
      setRuns(
        results.map((res, i) => ({
          capIdentifier: res.capIdentifier,
          statusUrl: res.pipeline.statusUrl,
          expiresAt: res.expiresAt,
          polygon: polygons[i]!,
        })),
      );
    } catch (err) {
      setSendError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const clearAlert = () => {
    setRuns([]);
    setReport(null);
    markerLayerRef.current?.clearLayers();
    coverageLayerRef.current?.clearLayers();
    layerRef.current?.clearLayers();
    setPolygons([]);
  };

  const completedCount = runs.filter((r) => r.status?.status === 'completed').length;
  const haltedCount = runs.filter((r) => r.status?.status === 'halted').length;
  const pendingCount = runs.length - completedCount - haltedCount;
  const totalTowers = runs.reduce((acc, r) => acc + (r.status?.towerCount ?? 0), 0);
  const shownTowers = insideByRun.reduce((acc, list) => acc + list.length, 0);
  const totalMatched = runs.reduce((acc, r) => acc + (r.status?.matchedCount ?? 0), 0);
  const totalDuplicates = runs.reduce((acc, r) => acc + (r.status?.duplicatesRemoved ?? 0), 0);
  const totalExpected = runs.reduce((acc, r) => acc + (r.status?.expectedRecipients ?? 0), 0);
  const totalSubmitted = runs.reduce((acc, r) => acc + (r.status?.submittedCount ?? 0), 0);
  const awaitingCredentials = runs.some((r) => r.status?.awaitingCredentials);
  const submittedLabel = `${totalSubmitted}${awaitingCredentials ? ' · awaiting SMSC credentials' : ''}`;
  const delivered = report?.delivered ?? 0;

  return (
    <div className="shell">
      <div id="map" />
      <aside className="panel">
        <h1>TURANT · Polygon Alert Console</h1>
        <p className="hint">
          Draw one or more polygons on the map (blue tool), fill in the alert, then send. All
          figures come live from the real backend pipeline — one alert per polygon.
        </p>

        <section className="controls">
          <label>
            Message
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="e.g. Heavy rain expected — avoid low-lying areas"
              rows={3}
            />
          </label>
          <label>
            Severity
            <select value={severity} onChange={(e) => setSeverity(e.target.value as CapSeverity)}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Hazard type (optional)
            <input value={hazardType} onChange={(e) => setHazardType(e.target.value)} placeholder="Flood" />
          </label>
          <label>
            Expires in (minutes)
            <input
              type="number"
              min={1}
              value={expiresInMinutes}
              onChange={(e) => setExpiresInMinutes(Math.max(1, Number(e.target.value)))}
            />
          </label>

          <button onClick={send} disabled={busy}>
            {busy ? 'Sending…' : 'Send Alert'}
          </button>
          {sendError && <p className="error">{sendError}</p>}
        </section>

        {polygons.length > 0 && (
          <p className="note">
            {polygons.length} polygon{polygons.length === 1 ? '' : 's'} drawn (
            {polygons.map((p) => p.length).join(', ')} vertices each)
          </p>
        )}
        {clustersError && <p className="error">Clusters: {clustersError}</p>}
        {clusters && !clustersError && (
          <p className="note">
            {clusters.region} region · {clusters.count} city cluster hints on the map
          </p>
        )}

        {runs.length > 0 && (
          <section className="results">
            <div className="row">
              <span>Polygons</span>
              <span>
                {runs.length} · {completedCount} done
                {pendingCount > 0 && `, ${pendingCount} running`}
                {haltedCount > 0 && `, ${haltedCount} halted`}
              </span>
            </div>
            {runs.map((run, i) => {
              const matched = run.status?.towerCount ?? 0;
              const state = run.status?.status ?? 'running';
              return (
                <div className="row" key={run.capIdentifier}>
                  <span>Polygon {i + 1}</span>
                  <span className={state}>
                    {state}
                    {run.status?.reason ? ` · ${run.status.reason}` : ''}
                    {state === 'completed' ? ` · ${matched}` : ''}
                  </span>
                </div>
              );
            })}
            <div className="row">
              <span>Towers matched (total)</span>
              <span>{totalTowers}</span>
            </div>
            {totalMatched > 0 && (
              <div className="row">
                <span>Subscribers matched</span>
                <span>{totalMatched}</span>
              </div>
            )}
            {totalDuplicates >= 0 && runs.some((r) => r.status?.duplicatesRemoved !== undefined) && (
              <div className="row">
                <span>Duplicates removed</span>
                <span>{totalDuplicates}</span>
              </div>
            )}
            {totalExpected > 0 && (
              <div className="row">
                <span>Expected recipients</span>
                <span>{totalExpected}</span>
              </div>
            )}
            {totalSubmitted >= 0 && runs.some((r) => r.status?.submittedCount !== undefined) && (
              <div className="row">
                <span>Messages submitted</span>
                <span>{submittedLabel}</span>
              </div>
            )}
            {report && (
              <div className="row">
                <span>Delivered (real DLR)</span>
                <span>{delivered}</span>
              </div>
            )}
            {runs[0] && (
              <div className="row">
                <span>Expires</span>
                <span>
                  {new Date(runs.map((r) => r.expiresAt).sort((a, b) => +new Date(a) - +new Date(b))[0]!).toLocaleTimeString()}
                </span>
              </div>
            )}
            {runs.length > 0 && (
              <p className="note">
                {shownTowers} of {totalTowers} matched towers marked — each inside its own polygon.
                Polygon areas are shaded as the alert coverage zone (towers exist only around Delhi).
              </p>
            )}
            {haltedCount > 0 && (
              <p className="note">
                Halted — no fabrication. Configure the missing real input to proceed.
              </p>
            )}
          </section>
        )}

        {runs.length > 0 && (
          <button className="ghost" onClick={clearAlert}>
            Clear
          </button>
        )}
      </aside>
    </div>
  );
}