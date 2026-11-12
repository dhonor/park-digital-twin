import type { RefObject } from 'react'
import type { ConnState } from '../api/realtime'

interface Props {
  coordRef: RefObject<HTMLSpanElement>
  backend: string
  conn: ConnState
  lodLabel: string
  deviceCount: number
}

export function StatusBar({ coordRef, backend, conn, lodLabel, deviceCount }: Props) {
  return (
    <footer className="statusbar">
      <span className="status-coord" ref={coordRef}>
        E — N —
      </span>
      <span>数据源 {backend === 'postgis' ? 'PostGIS' : '内存 GeoJSON'}</span>
      <span>设备 {deviceCount}</span>
      <span>精度 {lodLabel}</span>
      <span className="status-sep" />
      <span className={`status-conn status-conn-${conn}`}>
        {conn === 'online' ? 'WS 已连接' : conn === 'connecting' ? 'WS 连接中' : 'WS 断开'}
      </span>
      <span className="status-right">F 回全景 · Esc 返回 · 1/2/3 切精度</span>
    </footer>
  )
}
