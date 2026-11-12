import type { Alarm, EnergySummary, Overview } from '../types'
import { STATUS_HEX, STATUS_LABEL } from '../cesium/style'
import type { DeviceStatus } from '../types'
import { Sparkline } from './Sparkline'

interface Props {
  overview: Overview | null
  alarms: Alarm[]
  energy: EnergySummary | null
  onAck: (id: string) => void
  /** 告警一键定位: 直达设备机位并打开详情, 形成"发现→定位→处置"闭环 */
  onLocate: (alarm: Alarm) => void
}

const LEVEL_TEXT = { critical: '严重', warning: '预警', info: '提示' } as const

export function OverviewPanel({ overview, alarms, energy, onAck, onLocate }: Props) {
  const curve = overview?.energy.curve.map((item) => item.value) ?? []
  const status = overview?.device_status ?? {}
  const maxTop = energy?.top5[0]?.energy_kwh_today ?? 1

  return (
    <div className="panel-scroll">
      <div className="section section-energy">
        <div className="section-head">
          <h3>园区用能 · 24h</h3>
          <span className="hint">
            {overview ? `${(overview.energy.today_kwh / 1000).toFixed(2)} MWh` : '—'}
          </span>
        </div>
        <Sparkline data={curve} />
        <div className="legend-row">
          <span>00:00</span>
          <span>12:00</span>
          <span>24:00</span>
        </div>
      </div>

      <div className="section section-status">
        <div className="section-head">
          <h3>设备状态</h3>
          <span className="hint">实时</span>
        </div>
        <div className="status-bar-mix">
          {(['normal', 'warning', 'alarm', 'offline'] as DeviceStatus[]).map((key) => {
            const total = Object.values(status).reduce((sum, value) => sum + value, 0) || 1
            return (
              <i
                key={key}
                style={{
                  width: `${((status[key] ?? 0) / total) * 100}%`,
                  background: STATUS_HEX[key],
                }}
              />
            )
          })}
        </div>
        <div className="status-legend">
          {(['normal', 'warning', 'alarm', 'offline'] as DeviceStatus[]).map((key) => (
            <span key={key}>
              <i style={{ background: STATUS_HEX[key] }} />
              {STATUS_LABEL[key]} {status[key] ?? 0}
            </span>
          ))}
        </div>
      </div>

      <div className="section section-alarm">
        <div className="section-head">
          <h3>告警中心</h3>
          <span className="hint">{alarms.length} 条</span>
        </div>
        <div className="alarm-list">
          {alarms.length === 0 ? <p className="empty">暂无告警</p> : null}
          {alarms.slice(0, 8).map((alarm) => (
            <div className={`alarm alarm-${alarm.level}`} key={alarm.id}>
              <div className="alarm-main">
                <span className="alarm-level">{LEVEL_TEXT[alarm.level]}</span>
                <strong>{alarm.title}</strong>
              </div>
              <div className="alarm-meta">
                <span>
                  {alarm.value}
                  {alarm.unit} / 阈值 {alarm.threshold}
                  {alarm.unit}
                </span>
                <span>{alarm.ts.slice(11, 19)}</span>
                <span className="alarm-actions">
                  {alarm.device_id ? <button onClick={() => onLocate(alarm)}>定位</button> : null}
                  {alarm.status === 'open' ? (
                    <button onClick={() => onAck(alarm.id)}>确认</button>
                  ) : (
                    <em>已确认</em>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="section section-rank">
        <div className="section-head">
          <h3>能耗 Top5</h3>
          <span className="hint">kWh</span>
        </div>
        <div className="rank-list">
          {(energy?.top5 ?? []).map((item, index) => (
            <div className="rank-row" key={item.id}>
              <span className="rank-index">{index + 1}</span>
              <span className="rank-name">{item.name}</span>
              <span className="rank-track">
                <i style={{ width: `${(item.energy_kwh_today / maxTop) * 100}%` }} />
              </span>
              <span className="rank-value">{Math.round(item.energy_kwh_today)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
