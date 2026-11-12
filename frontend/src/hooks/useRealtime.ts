import { useEffect, useRef, useState } from 'react'
import { connectRealtime, type ConnState } from '../api/realtime'
import type { Alarm, Overview, TelemetryItem } from '../types'

interface Options {
  /** 场景就绪后才连: 否则 hello 里的设备快照会早于场景, 点位着色丢失 */
  enabled: boolean
  onTelemetry: (items: TelemetryItem[]) => void
  onAlarm: (alarm: Alarm) => void
  onOverview: (overview: Overview) => void
}

/**
 * 实时通道.
 *
 * 回调放进 ref: 连接本身只应该在 enabled 变化时重建一次.
 * 如果把它们放进依赖数组, 任何一次父组件重渲染都可能触发一次
 * 「断开 → 重连 → 重收 hello 快照」, 表现为状态栏的连接状态来回跳.
 */
export function useRealtime({ enabled, onTelemetry, onAlarm, onOverview }: Options): ConnState {
  const [conn, setConn] = useState<ConnState>('connecting')
  const handlers = useRef({ onTelemetry, onAlarm, onOverview })
  handlers.current = { onTelemetry, onAlarm, onOverview }

  useEffect(() => {
    if (!enabled) return
    return connectRealtime({
      onStatus: setConn,
      onTelemetry: (items) => handlers.current.onTelemetry(items),
      onAlarm: (alarm) => handlers.current.onAlarm(alarm),
      onOverview: (overview) => handlers.current.onOverview(overview),
    })
  }, [enabled])

  return conn
}
