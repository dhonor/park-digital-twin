import { useEffect, useState } from 'react'
import { DEVICE_TYPE_LABEL, STATUS_HEX, STATUS_LABEL } from '../cesium/style'
import type { DeviceProps } from '../types'

interface Props {
  device: DeviceProps
  buildingName?: string
  busy: boolean
  onClose: () => void
  onCommand: (payload: { action: string; value?: number }) => void
}

type PendingAction = 'restart' | 'reduce'

export function DevicePanel({ device, buildingName, busy, onClose, onCommand }: Props) {
  const { metric } = device
  const ratio = Math.max(
    0,
    Math.min(1, (metric.value - metric.min) / (metric.max - metric.min || 1)),
  )

  // 反控是"点了就下发"的不可逆动作: 首次点击只进入待确认态, 再点一次才执行.
  // 4 秒无操作自动撤销, 避免确认态一直挂着被顺手点掉.
  const [pending, setPending] = useState<PendingAction | null>(null)
  useEffect(() => {
    setPending(null)
  }, [device.id])
  useEffect(() => {
    if (!pending) return
    const timer = window.setTimeout(() => setPending(null), 4000)
    return () => window.clearTimeout(timer)
  }, [pending])

  const trigger = (action: PendingAction) => {
    if (pending !== action) {
      setPending(action)
      return
    }
    setPending(null)
    onCommand(
      action === 'restart'
        ? { action: 'restart' }
        : { action: 'set', value: Number((metric.value * 0.9).toFixed(2)) },
    )
  }

  return (
    <div className="panel-scroll">
      <div className="detail-head">
        <div>
          <h2>{device.name}</h2>
          <p>
            {DEVICE_TYPE_LABEL[device.type] ?? device.type_label ?? device.type} · {device.id}
          </p>
        </div>
        <button className="close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>

      <div className="device-hero">
        <span className="status-pill" style={{ color: STATUS_HEX[device.status] }}>
          <i style={{ background: STATUS_HEX[device.status] }} />
          {STATUS_LABEL[device.status]}
        </span>
        <div className="metric-value">
          <strong>{metric.value}</strong>
          <em>{metric.unit}</em>
        </div>
        <div className="metric-track">
          <i style={{ width: `${ratio * 100}%`, background: STATUS_HEX[device.status] }} />
        </div>
        <div className="metric-range">
          <span>{metric.min}</span>
          <span>{metric.key}</span>
          <span>{metric.max}</span>
        </div>
      </div>

      <div className="kv-list">
        <div>
          <span>所属建筑</span>
          <strong>{buildingName ?? device.building_id ?? '室外'}</strong>
        </div>
        <div>
          <span>安装楼层</span>
          <strong>{device.floor ? `${device.floor}F` : '室外'}</strong>
        </div>
        <div>
          <span>采集时间</span>
          <strong>{(device.ts ?? '').slice(11, 19) || '实时推送'}</strong>
        </div>
        <div>
          <span>通信协议</span>
          <strong>MQTT / 4G</strong>
        </div>
      </div>

      <div className="model-badge">
        <i aria-hidden />
        <span>三维高模 · Three.js 局部增强层</span>
      </div>

      <div className="section">
        <div className="section-head">
          <h3>反控</h3>
          <span className="hint">演示通道</span>
        </div>
        <div className="action-row">
          <button
            className={`btn${pending === 'restart' ? ' is-confirm' : ''}`}
            disabled={busy}
            onClick={() => trigger('restart')}
          >
            {pending === 'restart' ? '再点一次：确认重启' : '重启设备'}
          </button>
          <button
            className={`btn${pending === 'reduce' ? ' is-confirm' : ''}`}
            disabled={busy}
            onClick={() => trigger('reduce')}
          >
            {pending === 'reduce' ? '再点一次：确认下调' : '负荷下调 10%'}
          </button>
        </div>
        <p className="card-note">
          危险操作需二次确认 · 生产环境替换为 MQTT 下发 + 设备回执, 接口签名保持不变。
        </p>
      </div>
    </div>
  )
}
