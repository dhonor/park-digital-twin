import type { LayerMeta, LodMeta } from '../types'

interface Props {
  layers: LayerMeta[]
  lod: LodMeta | undefined
  visibility: Record<string, boolean>
  onToggle: (key: string) => void
  onAll: (visible: boolean) => void
}

const GEOM_LABEL: Record<string, string> = {
  Polygon: '面',
  LineString: '线',
  Point: '点',
}

export function LayerPanel({ layers, lod, visibility, onToggle, onAll }: Props) {
  return (
    <section className="card card-cyan">
      <div className="card-head">
        <h2>图层</h2>
        <div className="card-actions">
          <button className="ghost" onClick={() => onAll(true)}>
            全显
          </button>
          <button className="ghost" onClick={() => onAll(false)}>
            全隐
          </button>
        </div>
      </div>

      <div className="layer-list">
        {layers.map((layer) => {
          const visible = visibility[layer.key] ?? layer.default_visible
          return (
            <button
              key={layer.key}
              className={`layer-row${visible ? ' is-on' : ''}`}
              onClick={() => onToggle(layer.key)}
              aria-pressed={visible}
              title={layer.note}
            >
              <span className={`geom geom-${layer.geometry.toLowerCase()}`}>
                {GEOM_LABEL[layer.geometry] ?? '·'}
              </span>
              <span className="layer-name">
                {layer.name}
                <em>{layer.name_en}</em>
              </span>
              <span className="layer-count">{layer.feature_count}</span>
              <span className="switch" aria-hidden />
            </button>
          )
        })}
      </div>

      <p className="card-note">
        {lod
          ? `${lod.key} · ${lod.label} · 抽稀 ${lod.tolerance_m}m · 坐标保留 ${lod.coord_precision} 位`
          : '—'}
      </p>
    </section>
  )
}
