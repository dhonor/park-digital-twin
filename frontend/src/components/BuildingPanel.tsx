import { STATUS_HEX, STATUS_LABEL } from '../cesium/style'
import type { BuildingDetail } from '../types'

interface Props {
  building: BuildingDetail
  floorClip: number
  onFloorClip: (floor: number) => void
  onReset: () => void
  onClose: () => void
  onSelectDevice: (id: string) => void
}

export function BuildingPanel({
  building,
  floorClip,
  onFloorClip,
  onReset,
  onClose,
  onSelectDevice,
}: Props) {
  const occupancy = building.floor_list.reduce((sum, floor) => sum + floor.occupancy, 0)

  return (
    <div className="panel-scroll">
      <div className="detail-head">
        <div>
          <h2>{building.name}</h2>
          <p>
            {building.type_label} · {building.id} · {building.year} 年投用
          </p>
        </div>
        <button className="close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>

      <div className="tile-grid">
        <div className="tile">
          <span>层数</span>
          <strong>{building.floors}</strong>
          <em>F</em>
        </div>
        <div className="tile">
          <span>建筑面积</span>
          <strong>{(building.gfa_m2 / 10000).toFixed(1)}</strong>
          <em>万㎡</em>
        </div>
        <div className="tile">
          <span>今日用能</span>
          <strong>{Math.round(building.energy_kwh_today)}</strong>
          <em>kWh</em>
        </div>
        <div className="tile">
          <span>在楼人数</span>
          <strong>{occupancy}</strong>
          <em>人</em>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h3>楼层剖切</h3>
          <button className="ghost" onClick={onReset}>
            复原
          </button>
        </div>
        <input
          className="slider"
          type="range"
          min={1}
          max={building.floors}
          value={floorClip}
          onChange={(event) => onFloorClip(Number(event.target.value))}
        />
        <div className="slider-meta">
          <span>显示至 {floorClip}F</span>
          <span>层高 {building.floor_height.toFixed(2)}m</span>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h3>设备 ({building.device_summary.total})</h3>
          <span className="hint">
            告警 {building.device_summary.alarm ?? 0} · 离线 {building.device_summary.offline ?? 0}
          </span>
        </div>
        <div className="device-list">
          {building.devices.map((device) => (
            <button
              key={device.id}
              className="device-row"
              onClick={() => onSelectDevice(device.id)}
            >
              <i style={{ background: STATUS_HEX[device.status] }} />
              <span className="device-name">
                {device.name}
                <em>{STATUS_LABEL[device.status]}</em>
              </span>
              <span className="device-value">
                {device.metric.value}
                <em>{device.metric.unit}</em>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h3>分层面积</h3>
          <span className="hint">{building.desc}</span>
        </div>
        <div className="floor-list">
          {building.floor_list.map((floor) => (
            <div
              className={`floor-row${floor.floor === floorClip ? ' is-active' : ''}`}
              key={floor.floor}
            >
              <span className="floor-name">{floor.name}</span>
              <span>{Math.round(floor.area_m2)} ㎡</span>
              <span>{floor.rooms} 间</span>
              <span>{floor.occupancy} 人</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
