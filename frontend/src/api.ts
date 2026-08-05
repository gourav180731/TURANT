/**
 * Typed client for the real TURANT backend. Every value rendered by the UI
 * originates here from a live API response — this module has zero hardcoded
 * numbers, and the backend itself only ever returns real pipeline/DLR data.
 */

export type CapSeverity = 'Extreme' | 'Severe' | 'Moderate' | 'Minor';

export interface CityCluster {
  id: string;
  name: string;
  region: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  weight: number;
}

export interface ClustersResponse {
  region: string;
  count: number;
  clusters: CityCluster[];
}

export interface ManualAlertPayload {
  polygon: [number, number][];
  message: string;
  severity: CapSeverity;
  expiresInMinutes: number;
  hazardType?: string;
}

export interface PipelineRef {
  status: string;
  stage: string;
  statusUrl: string;
}

export interface ManualAlertResponse {
  alertId: string;
  capIdentifier: string;
  expiresAt: string;
  duplicate: boolean;
  source: string;
  sender: string;
  pipeline: PipelineRef;
}

export interface PipelineStatus {
  capIdentifier: string;
  status: 'running' | 'halted' | 'completed';
  stage: string;
  haltedAt?: string;
  reason?: string;
  towerCount?: number;
  matchedCount?: number;
  duplicatesRemoved?: number;
  expectedRecipients?: number;
  submittedCount?: number;
  updatedAtMs: number;
  traceRef?: string;
}

export interface TowerMarker {
  id: string;
  cellId: string;
  latitude: number;
  longitude: number;
  coverageRadiusM?: number;
}

export interface TowersResponse {
  capIdentifier: string;
  count: number;
  towers: TowerMarker[];
}

export interface DeliveryReport {
  capIdentifier: string;
  expectedRecipients: number;
  delivered: number;
  deliveredTo: string[];
  firstReceivedEpochMs: number | null;
  lastReceivedEpochMs: number | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    let detail = `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text) as { error?: string };
      if (body?.error) detail += ` — ${body.error}`;
    } catch {
      /* non-JSON error body; keep the HTTP status */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export async function fetchClusters(): Promise<ClustersResponse> {
  return json<ClustersResponse>(await fetch('/api/v1/sim/clusters'));
}

export async function sendManualAlert(payload: ManualAlertPayload): Promise<ManualAlertResponse> {
  return json<ManualAlertResponse>(
    await fetch('/api/v1/alerts/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

export async function fetchPipelineStatus(statusUrl: string): Promise<PipelineStatus> {
  return json<PipelineStatus>(await fetch(statusUrl));
}

export async function fetchTowers(capIdentifier: string): Promise<TowersResponse> {
  return json<TowersResponse>(
    await fetch(`/api/v1/alerts/${encodeURIComponent(capIdentifier)}/towers`),
  );
}

export async function fetchDeliveryReport(capIdentifier: string): Promise<DeliveryReport> {
  return json<DeliveryReport>(
    await fetch(`/api/v1/alerts/${encodeURIComponent(capIdentifier)}/report`),
  );
}