import type { ConnState } from '../api/realtime'
import type { LodMeta, Park } from '../types'
import { Clock } from './Clock'

interface Props {
  park: Park | null
  mode: '3d' | '2d'
  onMode: (mode: '3d' | '2d') => void
  lod: number
  lods: LodMeta[]
  onLod: (lod: number) => void
  conn: ConnState
  shellAvailable: boolean
  shellMode: 'model' | 'vector'
  onShellMode: (mode: 'model' | 'vector') => void
  onHome: () => void
}

const CONN_TEXT: Record<ConnState, string> = {
  online: '实时在线',
  connecting: '连接中',
  offline: '已断开',
}

export function TopBar({
  park,
  mode,
  onMode,
  lod,
  lods,
  onLod,
  conn,
  shellAvailable,
  shellMode,
  onShellMode,
  onHome,
}: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        <div className="brand-text">
          <strong>{park?.name ?? '园区数字孪生'}</strong>
          <span>{park?.full_name ?? '正在连接孪生底座'}</span>
        </div>
      </div>

      <div className="topbar-center">
        <div className="segmented" role="group" aria-label="视图模式">
          <button className={mode === '3d' ? 'active' : ''} onClick={() => onMode('3d')}>
            三维
          </button>
          <button className={mode === '2d' ? 'active' : ''} onClick={() => onMode('2d')}>
            平面
          </button>
        </div>
        <span className="segmented-label">视图精度</span>
        <div className="segmented" role="group" aria-label="视图精度">
          {lods.map((item) => (
            <button
              key={item.lod}
              className={lod === item.lod ? 'active' : ''}
              onClick={() => onLod(item.lod)}
              title={`${item.viewport} · 抽稀 ${item.tolerance_m}m`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {shellAvailable ? (
          <>
            <span className="segmented-label">建筑表现</span>
            <div className="segmented" role="group" aria-label="建筑表现">
              <button
                className={shellMode === 'model' ? 'active' : ''}
                onClick={() => onShellMode('model')}
                title="三维外壳 (3D Tiles)"
              >
                模型
              </button>
              <button
                className={shellMode === 'vector' ? 'active' : ''}
                onClick={() => onShellMode('vector')}
                title="矢量拉伸体块"
              >
                体块
              </button>
            </div>
          </>
        ) : null}
      </div>

      <div className="topbar-right">
        <button className="top-action" onClick={onHome} title="回到园区全景（快捷键 F）">
          回全景
        </button>
        <span className={`conn conn-${conn}`}>
          <i aria-hidden />
          {CONN_TEXT[conn]}
        </span>
        <Clock />
      </div>
    </header>
  )
}
