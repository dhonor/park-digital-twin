export type DeviceStatus = 'normal' | 'warning' | 'alarm' | 'offline'

export interface Park {
  id: string
  name: string
  full_name: string
  province: string
  city: string
  address: string
  center: [number, number]
  ground_altitude: number
  area_m2: number
  green_ratio: number
  building_count: number
  device_count: number
  camera: { height: number; heading: number; pitch: number }
  bbox: [number, number, number, number]
  boundary: number[][][]
  backend: string
  capabilities: {
    layer_lod: string[]
    vector_tiles: boolean
    ogc_services: boolean
    realtime_transport: string
  }
  engines: { primary: string; note: string }
}

export interface TilesetInfo {
  available: boolean
  url: string | null
  format?: string
  tile_count?: number
  up_axis?: string
  source?: string
  generator?: string
  note?: string
  swap?: string
}

export interface LodMeta {
  lod: number
  key: string
  label: string
  viewport: string
  tolerance_m: number
  coord_precision: number
  bbox_only: boolean
}

export interface LayerMeta {
  key: string
  name: string
  name_en: string
  geometry: string
  default_visible: boolean
  note: string
  feature_count: number
  source_bytes: number
  attributes: Record<string, string[]>
}

export interface LayerCatalog {
  default_lod: number
  lods: LodMeta[]
  layers: LayerMeta[]
}

export interface LightweightStats {
  layer: string
  layer_name: string
  lod: number
  lod_key: string
  lod_label: string
  viewport_hint: string
  tolerance_m: number
  coord_precision: number
  bbox_only: boolean
  features: number
  attributes_kept: string[]
  points: { source: number; output: number; reduction: number }
  bytes: {
    source: number
    output: number
    reduction: number
    gzip_source: number
    gzip_output: number
    gzip_reduction: number
    encoding: string
  }
  pipeline: string[]
}

export interface GeoFeature {
  type: 'Feature'
  id?: string
  geometry: { type: string; coordinates: unknown }
  properties: Record<string, unknown>
}

export interface FeatureCollection {
  type: 'FeatureCollection'
  name?: string
  features: GeoFeature[]
  _lightweight?: LightweightStats
}

export interface DeviceMetric {
  key: string
  unit: string
  value: number
  min: number
  max: number
}

export interface DeviceProps {
  id: string
  name: string
  type: string
  type_label?: string
  building_id: string | null
  floor: number
  status: DeviceStatus
  metric: DeviceMetric
  ts?: string
}

export interface BuildingSummary {
  id: string
  name: string
  type: string
  type_label: string
  height: number
  floors: number
  area_m2: number
  gfa_m2: number
  center: [number, number]
  energy_kwh_today: number
  carbon_kg_today: number
  device_count: number
  alarm_count: number
}

export interface FloorInfo {
  floor: number
  name: string
  area_m2: number
  rooms: number
  occupancy: number
  usage: string
}

export interface Alarm {
  id: string
  level: 'critical' | 'warning' | 'info'
  title: string
  device_id: string
  device_name: string
  building_id: string | null
  metric: string
  value: number
  threshold: number
  unit: string
  ts: string
  status: 'open' | 'acked'
}

export interface BuildingDetail extends BuildingSummary {
  floor_height: number
  year: number
  desc: string
  energy_target: number
  energy_24h: number[]
  floor_list: FloorInfo[]
  devices: DeviceProps[]
  alarms: Alarm[]
  device_summary: Record<string, number>
  live: { energy_kwh_today: number; energy_target: number; load_rate: number }
}

export interface Kpi {
  key: string
  label: string
  value: number
  unit: string
  sub: string
  tone: 'cyan' | 'amber' | 'green' | 'red' | 'violet' | 'slate'
}

export interface Overview {
  kpi: Kpi[]
  device_status: Record<string, number>
  alarm_counts: { critical: number; warning: number; info: number }
  energy: {
    today_kwh: number
    target_kwh: number
    carbon_kg: number
    curve: { hour: number; value: number }[]
  }
  updated_at: string
}

export interface EnergyBuilding {
  id: string
  name: string
  type: string
  floors: number
  energy_kwh_today: number
  energy_target: number
  intensity: number
  peak_kw: number
  curve: number[]
}

export interface EnergySummary {
  unit: string
  range: string
  campus_curve: { hour: number; value: number }[]
  buildings: EnergyBuilding[]
  top5: EnergyBuilding[]
}

export interface LightweightReport {
  policy: {
    principle: string
    stages: string[]
    note: string
  }
  lods: {
    lod: number
    lod_key: string
    layers: LightweightStats[]
    total: {
      bytes_source: number
      bytes_output: number
      bytes_reduction: number
      gzip_source: number
      gzip_output: number
      gzip_reduction: number
      points_source: number
      points_output: number
      points_reduction: number
    }
    note: string
  }[]
}

export interface TelemetryItem {
  id: string
  status: DeviceStatus
  value: number
  metric: string
  unit: string
}
