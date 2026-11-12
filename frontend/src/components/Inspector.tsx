import type { Alarm, BuildingDetail, DeviceProps, EnergySummary, Overview } from '../types'
import { BuildingPanel } from './BuildingPanel'
import { DevicePanel } from './DevicePanel'
import { OverviewPanel } from './OverviewPanel'

interface Props {
  building: BuildingDetail | null
  device: DeviceProps | null
  overview: Overview | null
  energy: EnergySummary | null
  alarms: Alarm[]
  floorClip: number
  busy: boolean
  loading: boolean
  /** 设备所属楼栋名称, 用于层级返回 */
  buildingName?: string
  onClose: () => void
  onAck: (id: string) => void
  onLocate: (alarm: Alarm) => void
  onFloorClip: (floor: number) => void
  onResetFloor: () => void
  onSelectDevice: (id: string) => void
  onBackToBuilding?: () => void
  onCommand: (payload: { action: string; value?: number }) => void
}

export function Inspector(props: Props) {
  const { building, device, overview, energy, alarms } = props
  const title = device ? '设备详情' : building ? '楼栋详情' : '园区态势'

  return (
    <aside className={`panel panel-right${props.loading ? ' is-loading' : ''}`}>
      <div className="panel-title">
        <span className="panel-title-main">
          {/* 层级可回溯: 设备 → 所属楼栋 → 园区, 不用一路退到态势再重新找楼 */}
          {props.onBackToBuilding ? (
            <button className="crumb" onClick={props.onBackToBuilding} title="返回所属楼栋">
              ← {props.buildingName ?? props.device?.building_id ?? '楼栋'}
            </button>
          ) : null}
          {title}
        </span>
        {building || device ? (
          <button className="ghost" onClick={props.onClose}>
            返回态势
          </button>
        ) : (
          <span className="hint">实时</span>
        )}
      </div>

      {device ? (
        <DevicePanel
          device={device}
          buildingName={props.buildingName}
          busy={props.busy}
          onClose={props.onClose}
          onCommand={props.onCommand}
        />
      ) : building ? (
        <BuildingPanel
          building={building}
          floorClip={props.floorClip}
          onFloorClip={props.onFloorClip}
          onReset={props.onResetFloor}
          onClose={props.onClose}
          onSelectDevice={props.onSelectDevice}
        />
      ) : (
        <OverviewPanel
          overview={overview}
          energy={energy}
          alarms={alarms}
          onAck={props.onAck}
          onLocate={props.onLocate}
        />
      )}

      {props.loading ? (
        <div className="panel-loading">
          <span className="spinner" aria-hidden />
          <span>加载中</span>
        </div>
      ) : null}
    </aside>
  )
}
