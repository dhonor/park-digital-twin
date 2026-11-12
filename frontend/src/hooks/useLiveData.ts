import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { api } from '../api/client'
import type { ConnState } from '../api/realtime'
import type { TwinScene } from '../cesium/scene'
import type {
  Alarm,
  BuildingDetail,
  DeviceProps,
  EnergySummary,
  LightweightReport,
  Overview,
  TelemetryItem,
} from '../types'
import { useRealtime } from './useRealtime'

interface Options {
  ready: boolean
  sceneRef: MutableRefObject<TwinScene | null>
  setDevice: Dispatch<SetStateAction<DeviceProps | null>>
  setBuilding: Dispatch<SetStateAction<BuildingDetail | null>>
  setAlarms: Dispatch<SetStateAction<Alarm[]>>
  setOverview: Dispatch<SetStateAction<Overview | null>>
  setEnergy: Dispatch<SetStateAction<EnergySummary | null>>
  setReport: Dispatch<SetStateAction<LightweightReport | null>>
}

/**
 * 服务端数据流入: 实时推送落地 + KPI 兜底轮询 + 首屏静态数据.
 *
 * 三条链路各自的目的不同, 放在一处才好读:
 *   1. WS telemetry → 点位着色 + 已打开面板的数值 (否则面板是打开那一刻的快照);
 *   2. WS overview  → 顶部 KPI, 多终端时由服务端统一推, 不必各自轮询;
 *   3. 轮询          → 仅在 WS 未就绪时兜底 (connRef 守卫), 避免双份请求;
 *      首屏另外拉一次能耗/轻量化报告/告警, 这三份数据不随遥测频繁变化。
 */
export function useLiveData({
  ready,
  sceneRef,
  setDevice,
  setBuilding,
  setAlarms,
  setOverview,
  setEnergy,
  setReport,
}: Options): ConnState {
  const applyTelemetry = useCallback(
    (items: TelemetryItem[]) => {
      sceneRef.current?.updateDevices(items)
      const byId = new Map(items.map((item) => [item.id, item]))

      setDevice((current) => {
        if (!current) return current
        const hit = byId.get(current.id)
        if (!hit) return current
        return { ...current, status: hit.status, metric: { ...current.metric, value: hit.value } }
      })

      setBuilding((current) => {
        if (!current) return current
        let changed = false
        const devices = current.devices.map((item) => {
          const hit = byId.get(item.id)
          if (!hit) return item
          changed = true
          return { ...item, status: hit.status, metric: { ...item.metric, value: hit.value } }
        })
        if (!changed) return current
        const summary: Record<string, number> = {
          total: devices.length,
          normal: 0,
          warning: 0,
          alarm: 0,
          offline: 0,
        }
        for (const item of devices) summary[item.status] = (summary[item.status] ?? 0) + 1
        return { ...current, devices, device_summary: summary }
      })
    },
    [sceneRef, setDevice, setBuilding],
  )

  const conn = useRealtime({
    enabled: ready,
    onTelemetry: applyTelemetry,
    onAlarm: (alarm) => setAlarms((previous) => [alarm, ...previous].slice(0, 40)),
    onOverview: setOverview,
  })

  // 轮询守卫要读"当前"连接状态: 用 effect 同步到 ref, 不在渲染期赋值
  const connRef = useRef<ConnState>('connecting')
  useEffect(() => {
    connRef.current = conn
  }, [conn])

  useEffect(() => {
    if (!ready) return
    let alive = true

    const pull = async () => {
      // WS 在线时 KPI 由服务端推送, 不再每终端各自轮询
      if (connRef.current === 'online') return
      try {
        const data = await api.overview()
        if (alive) setOverview(data)
      } catch {
        /* 网络抖动忽略 */
      }
    }
    void pull()
    const timer = window.setInterval(pull, 5000)

    Promise.all([api.energy(), api.lightweightReport(), api.alarms()])
      .then(([energyData, reportData, alarmData]) => {
        if (!alive) return
        setEnergy(energyData)
        setReport(reportData)
        setAlarms(alarmData.items)
      })
      .catch(() => undefined)

    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [ready, setOverview, setEnergy, setReport, setAlarms])

  return conn
}
