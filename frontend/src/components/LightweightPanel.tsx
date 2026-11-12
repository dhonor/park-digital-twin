import type { LightweightReport, LightweightStats } from '../types'

interface Props {
  stats: Record<string, LightweightStats>
  report: LightweightReport | null
  lod: number
  onLod: (lod: number) => void
}

function kb(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`
}

export function LightweightPanel({ stats, report, lod, onLod }: Props) {
  const items = Object.values(stats)
  const totalSource = items.reduce((sum, item) => sum + item.bytes.gzip_source, 0)
  const totalOutput = items.reduce((sum, item) => sum + item.bytes.gzip_output, 0)
  const reduction = totalSource ? 1 - totalOutput / totalSource : 0
  const rows = items
    .map((item) => ({ ...item, saving: Math.max(0, item.bytes.gzip_reduction) }))
    .sort((a, b) => b.saving - a.saving)
    .slice(0, 5)

  return (
    <section className="card card-violet">
      <div className="card-head">
        <h2>数据轻量化</h2>
        <span className="hint">gzip 实测</span>
      </div>

      <div className="lw-hero">
        <strong>{(reduction * 100).toFixed(1)}%</strong>
        <span>
          传输量降幅 · {kb(totalSource)} → {kb(totalOutput)}
        </span>
      </div>

      <div className="lw-bars">
        {rows.map((item) => (
          <div className="lw-bar" key={item.layer}>
            <span className="lw-bar-name">{item.layer_name}</span>
            <span className="lw-bar-track">
              <i style={{ width: `${Math.min(100, item.saving * 100).toFixed(1)}%` }} />
            </span>
            <span className="lw-bar-value">{(item.saving * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>

      <div className="lw-lods">
        {(report?.lods ?? []).map((item) => (
          <button
            key={item.lod}
            className={`lw-lod${item.lod === lod ? ' is-active' : ''}`}
            onClick={() => onLod(item.lod)}
          >
            <em>{item.lod_key}</em>
            <strong>-{(item.total.gzip_reduction * 100).toFixed(0)}%</strong>
            <span>{kb(item.total.gzip_output)}</span>
          </button>
        ))}
      </div>

      <p className="card-note">
        几何抽稀 / 坐标量化 / 属性白名单 / 视口增量, 四步都在服务端完成; 数据库只存一份原始要素。
      </p>
    </section>
  )
}
