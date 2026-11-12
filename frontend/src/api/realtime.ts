import type { Alarm, Overview, TelemetryItem } from '../types'

export type ConnState = 'connecting' | 'online' | 'offline'

interface Handlers {
  onStatus?: (state: ConnState) => void
  onTelemetry?: (items: TelemetryItem[], ts: string) => void
  onAlarm?: (alarm: Alarm) => void
  onHello?: (interval: number, deviceCount: number) => void
  /** 服务端统一推送的 KPI, 有它就不用再轮询 /api/overview */
  onOverview?: (overview: Overview) => void
}

interface ServerMessage {
  type: string
  ts: string
  items?: TelemetryItem[]
  alarm?: Alarm
  interval?: number
  devices?: unknown[]
  overview?: Overview
}

function wsUrl(): string {
  const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'
  if (/^https?:/.test(base)) return base.replace(/^http/, 'ws') + '/ws/realtime'
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${base}/ws/realtime`
}

/**
 * 断线自动重连 (指数退避, 最长 8s)。
 * 返回解绑函数, 组件卸载时调用。
 */
export function connectRealtime(handlers: Handlers): () => void {
  let socket: WebSocket | null = null
  let timer: number | undefined
  let retry = 0
  let disposed = false

  const open = () => {
    if (disposed) return
    handlers.onStatus?.('connecting')
    socket = new WebSocket(wsUrl())

    socket.onopen = () => {
      retry = 0
      handlers.onStatus?.('online')
    }

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as ServerMessage
        if (message.type === 'telemetry' && message.items) {
          handlers.onTelemetry?.(message.items, message.ts)
        } else if (message.type === 'alarm' && message.alarm) {
          handlers.onAlarm?.(message.alarm)
        } else if (message.type === 'overview' && message.overview) {
          handlers.onOverview?.(message.overview)
        } else if (message.type === 'hello') {
          if (message.overview) handlers.onOverview?.(message.overview)
          handlers.onHello?.(message.interval ?? 2, message.devices?.length ?? 0)
        }
      } catch {
        /* 忽略非 JSON 帧 */
      }
    }

    socket.onclose = () => {
      handlers.onStatus?.('offline')
      if (disposed) return
      retry += 1
      timer = window.setTimeout(open, Math.min(8000, 800 * 2 ** retry))
    }

    socket.onerror = () => socket?.close()
  }

  open()

  return () => {
    disposed = true
    window.clearTimeout(timer)
    socket?.close()
  }
}
