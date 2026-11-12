import type {
  Alarm,
  BuildingDetail,
  BuildingSummary,
  DeviceProps,
  EnergySummary,
  FeatureCollection,
  LayerCatalog,
  LightweightReport,
  Overview,
  Park,
  TilesetInfo,
} from '../types'

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${response.status} ${path}: ${text.slice(0, 200)}`)
  }
  return (await response.json()) as T
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const raw = search.toString()
  return raw ? `?${raw}` : ''
}

export const api = {
  park: () => request<Park>('/park'),

  tileset: () => request<TilesetInfo>('/tileset'),

  layers: () => request<LayerCatalog>('/layers'),

  layer: (key: string, params: { lod?: number; bbox?: string; limit?: number } = {}) =>
    request<FeatureCollection>(`/layers/${key}${qs(params)}`),

  buildings: () => request<{ count: number; items: BuildingSummary[] }>('/buildings'),

  building: (id: string) => request<BuildingDetail>(`/buildings/${id}`),

  devices: (params: { lod?: number; type?: string; status?: string; building_id?: string } = {}) =>
    request<
      FeatureCollection & {
        summary: { total: number; online_rate: number }
        types: Record<string, string>
      }
    >(`/devices${qs(params)}`),

  device: (id: string) => request<DeviceProps>(`/devices/${id}`),

  command: (id: string, payload: { action: string; metric?: string; value?: number }) =>
    request<{ ok: boolean; applied: Record<string, unknown> }>(`/devices/${id}/command`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  overview: () => request<Overview>('/overview'),

  energy: () => request<EnergySummary>('/energy/summary'),

  alarms: (params: { level?: string; status?: string } = {}) =>
    request<{ count: number; items: Alarm[] }>(`/alarms${qs(params)}`),

  ack: (id: string) => request<{ ok: boolean }>(`/alarms/${id}/ack`, { method: 'POST' }),

  lightweightReport: () => request<LightweightReport>('/lightweight/report'),
}
