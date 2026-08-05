import { useEffect, useRef, useState } from 'react';
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

export function App() {
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.FeatureGroup | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);

  const [clusters, setClusters] = useState<ClustersResponse | null>(null);
  const [clustersError, setClustersError] = useState<string | null>(null);

  const [polygon, setPolygon] = useState<[number, number][] | null>(null);
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<CapSeverity>('Severe');
  const [hazardType, setHazardType] = useState('');
  const [expiresInMinutes, setExpiresInMinutes] = useState(60);

  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [alert, setAlert] = useState<{ capIdentifier: string; statusUrl: string; expiresAt: string } | null>(null);
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [towers, setTowers] = useState<TowerMarker[] | null>(null);
  const [report, setReport] = useState<DeliveryReport | null>(null);
  const [traceRef, setTraceRef] = useState<string | null>(null);

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
        // Override the `_flat` property on this instance to the public API.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const self = this as any;
        Object.defineProperty(self, '_flat', {
          configurable: true,
          get() {
            return L.LineUtil.isFlat(this._latlngs || []);
          },
          set(v: boolean) {
            // leaflet-draw only reads _flat, but tolerate writes silently.
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

    // Extract outer-ring coordinates from any Polygon shape returned by
    // Leaflet. getLatLngs() returns LatLng[] | LatLng[][] | LatLng[][][]
    // depending on flat / holes / multi-polygon. We always want the first
    // (outer) ring.
    const extractOuterRing = (polygon: L.Polygon): L.LatLng[] => {
      const raw = polygon.getLatLngs() as L.LatLng[] | L.LatLng[][] | L.LatLng[][][];
      if (raw.length === 0) return [];
      // If the first element is a LatLng (has .lat), we already have the ring.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const first = raw[0] as any;
      if (first && typeof first === 'object' && 'lat' in first) {
        return raw as L.LatLng[];
      }
      // Otherwise it's nested at least one level — peel once.
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
    };

    const ringToCoords = (ring: L.LatLng[]): [number, number][] => {
      // Exclude the auto-closed duplicate tail that Leaflet appends.
      if (ring.length >= 2) {
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first.equals(last)) {
          return ring.slice(0, -1).map((ll) => [ll.lat, ll.lng] as [number, number]);
        }
      }
      return ring.map((ll) => [ll.lat, ll.lng] as [number, number]);
    };

    const onCreated = (e: L.LeafletEvent) => {
      const layer = (e as { layer: L.Polygon }).layer as L.Polygon;
      drawn.addLayer(layer);
      const ring = extractOuterRing(layer);
      setPolygon(ringToCoords(ring));
    };

    const onEdited = () => {
      // On edit, the FeatureGroup contains the (single) updated polygon.
      let ring: L.LatLng[] = [];
      drawn.eachLayer((lyr) => {
        if (lyr instanceof L.Polygon) {
          ring = extractOuterRing(lyr);
        }
      });
      setPolygon(ring.length ? ringToCoords(ring) : null);
    };

    const onDeleted = () => {
      setPolygon(null);
    };

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
    };
  }, []);

  // ---- Poll pipeline status until done, then fetch towers + report ---------
  useEffect(() => {
    if (!alert) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const s = await fetchPipelineStatus(alert.statusUrl);
        if (cancelled) return;
        setStatus(s);
        setTraceRef(s.traceRef ?? null);
        if (s.status === 'completed' || s.status === 'halted') {
          // Fetch the real matched towers (only exists once tower resolution ran).
          if (s.status === 'completed') {
            try {
              const t = await fetchTowers(alert.capIdentifier);
              if (!cancelled) setTowers(t.towers);
            } catch {
              /* towers endpoint may 404 for a fresh/halted run — show none */
            }
          }
          // Fetch the real DLR delivery report (0 receipts unless SMPP is live).
          try {
            const r = await fetchDeliveryReport(alert.capIdentifier);
            if (!cancelled) setReport(r);
          } catch {
            /* report available once the trace is recorded */
          }
          return;
        }
      } catch {
        if (!cancelled) setStatus({ status: 'running', stage: 'polling', capIdentifier: alert.capIdentifier, updatedAtMs: Date.now() });
      }
      // 1s poll while running (the backend completes in ~100ms in-memory).
      setTimeout(poll, 1000);
    };

    poll();
    return () => {
      cancelled = true;
    };
  }, [alert]);

  // ---- Draw matched tower markers when they arrive --------------------------
  useEffect(() => {
    const markers = markerLayerRef.current;
    if (!markers) return;
    markers.clearLayers();
    for (const t of towers ?? []) {
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
  }, [towers]);

  const send = async () => {
    setSendError(null);
    if (!polygon || polygon.length < 3) {
      setSendError('Draw a polygon on the map before sending.');
      return;
    }
    setBusy(true);
    setStatus(null);
    setTowers(null);
    setReport(null);
    setTraceRef(null);
    try {
      const res = await sendManualAlert({
        polygon,
        message: message.trim(),
        severity,
        expiresInMinutes,
        ...(hazardType.trim() ? { hazardType: hazardType.trim() } : {}),
      });
      setAlert({
        capIdentifier: res.capIdentifier,
        statusUrl: res.pipeline.statusUrl,
        expiresAt: res.expiresAt,
      });
    } catch (err) {
      setSendError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const clearAlert = () => {
    setAlert(null);
    setStatus(null);
    setTowers(null);
    setReport(null);
    setTraceRef(null);
    markerLayerRef.current?.clearLayers();
    layerRef.current?.clearLayers();
    setPolygon(null);
  };

  return (
    <div className="shell">
      <div id="map" />
      <aside className="panel">
        <h1>TURANT · Polygon Alert Console</h1>
        <p className="hint">
          Draw a polygon on the map (blue tool), fill in the alert, then send. All
          figures come live from the real backend pipeline.
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

        {polygon && (
          <p className="note">Polygon drawn: {polygon.length} vertices</p>
        )}
        {clustersError && <p className="error">Clusters: {clustersError}</p>}
        {clusters && !clustersError && (
          <p className="note">
            {clusters.region} region · {clusters.count} city cluster hints on the map
          </p>
        )}

        {status && (
          <section className="results">
            <div className="row">
              <span>Pipeline</span>
              <span className={status.status}>
                {status.status}
                {status.status === 'running' && ` · ${status.stage}`}
              </span>
            </div>
            {status.reason && <div className="row reason">{status.reason}</div>}
            {status.towerCount !== undefined && (
              <div className="row">
                <span>Towers matched</span>
                <span>{status.towerCount}</span>
              </div>
            )}
            {status.matchedCount !== undefined && (
              <div className="row">
                <span>Subscribers matched</span>
                <span>{status.matchedCount}</span>
              </div>
            )}
            {status.duplicatesRemoved !== undefined && (
              <div className="row">
                <span>Duplicates removed</span>
                <span>{status.duplicatesRemoved}</span>
              </div>
            )}
            {status.expectedRecipients !== undefined && (
              <div className="row">
                <span>Expected recipients</span>
                <span>{status.expectedRecipients}</span>
              </div>
            )}
            {status.submittedCount !== undefined && (
              <div className="row">
                <span>Messages submitted</span>
                <span>{status.submittedCount}</span>
              </div>
            )}
            {report && (
              <div className="row">
                <span>Delivered (real DLR)</span>
                <span>{report.delivered}</span>
              </div>
            )}
            {report &&
              status?.submittedCount !== undefined &&
              status.submittedCount - report.delivered > 0 && (
                <div className="row">
                  <span>Not yet delivered</span>
                  <span>{status.submittedCount - report.delivered}</span>
                </div>
              )}
            {alert && (
              <div className="row">
                <span>Expires</span>
                <span>{new Date(alert.expiresAt).toLocaleTimeString()}</span>
              </div>
            )}
            {towers && (
              <p className="note">
                {towers.length} matched towers marked on the map.
              </p>
            )}
            {traceRef && <p className="note">Trace: {traceRef}</p>}
            {status.status === 'halted' && (
              <p className="note">
                Halted — no fabrication. Configure the missing real input to proceed.
              </p>
            )}
          </section>
        )}

        {(status || alert) && (
          <button className="ghost" onClick={clearAlert}>
            Clear
          </button>
        )}
      </aside>
    </div>
  );
}