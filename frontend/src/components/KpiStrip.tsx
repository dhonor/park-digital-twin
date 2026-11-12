import type { Kpi } from '../types'

interface Props {
  kpi: Kpi[]
  updatedAt?: string
  collapsed: boolean
  onToggle: () => void
}

export function KpiStrip({ kpi, updatedAt, collapsed, onToggle }: Props) {
  if (!kpi.length) return <div className="kpi-dock" />

  return (
    <div className={`kpi-dock${collapsed ? ' is-collapsed' : ''}`}>
      <div className="kpi-dock-head">
        <span className="kpi-updated">{updatedAt ? `更新 ${updatedAt.slice(11, 19)}` : ''}</span>
        <button
          className="kpi-toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
          title={collapsed ? '展开底部统计' : '收起底部统计'}
        >
          {collapsed ? '展开统计' : '收起统计'}
          <i className="caret" aria-hidden />
        </button>
      </div>

      <div className="kpi-strip">
        {kpi.map((item) => (
          <article className={`kpi kpi-${item.tone}`} key={item.key}>
            <span className="kpi-label">{item.label}</span>
            <div className="kpi-value">
              <strong>{item.value}</strong>
              <em>{item.unit}</em>
            </div>
            <span className="kpi-sub">{item.sub}</span>
          </article>
        ))}
      </div>
    </div>
  )
}
