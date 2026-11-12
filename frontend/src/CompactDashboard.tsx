import { useEffect, useState } from 'react'
import { api } from './api/client'
import { Clock } from './components/Clock'
import { STATUS_HEX, STATUS_LABEL } from './cesium/style'
import type { Alarm, BuildingDetail, BuildingSummary, DeviceStatus, Overview, Park } from './types'

interface Props {
  /** 用户明确要求时再加载三维视图 */
  onOpen3D: () => void
}

const LEVEL_TEXT = { critical: '严重', warning: '预警', info: '提示' } as const

/**
 * 手机/低端设备形态: 不加载 Cesium, 只保留「看数 + 处置」。
 *
 * 巡检人员在现场要的是「哪栋楼几台设备异常、告警是什么」，不是转不动的三维体块。
 * 这样首屏只需 ~180KB 的壳 + 三次小请求, 主线程也不再被 WebGL 占住。
 */
export function CompactDashboard({ onOpen3D }: Props) {
  const [park, setPark] = useState<Park | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [alarms, setAlarms] = useState<Alarm[]>([])
  const [buildings, setBuildings] = useState<BuildingSummary[]>([])
  const [detail, setDetail] = useState<BuildingDetail | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [parkData, overviewData, alarmData, buildingData] = await Promise.all([
          api.park(),
          api.overview(),
          api.alarms(),
          api.buildings(),
        ])
        if (!alive) return
        setPark(parkData)
        setOverview(overviewData)
        setAlarms(alarmData.items)
        setBuildings(buildingData.items)
      } catch (err) {
        if (alive) setError(String(err))
      } finally {
        // 数据到位前用等高占位, 避免"内容从无到有"把下面的板块整体推下去(CLS)
        if (alive) setLoaded(true)
      }
    })()

    // 没有 WS 连接时用低频轮询兜底: 手机端不必维持长连接
    const timer = window.setInterval(() => {
      void api
        .overview()
        .then((data) => alive && setOverview(data))
        .catch(() => undefined)
    }, 15000)

    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const openBuilding = async (id: string) => {
    if (detail?.id === id) {
      setDetail(null)
      return
    }
    setBusy(id)
    try {
      setDetail(await api.building(id))
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const ack = async (id: string) => {
    try {
      await api.ack(id)
      setAlarms((previous) =>
        previous.map((alarm) => (alarm.id === id ? { ...alarm, status: 'acked' as const } : alarm)),
      )
    } catch (err) {
      setError(String(err))
    }
  }

  const deviceStatus = overview?.device_status ?? {}
  const totalDevices = Object.values(deviceStatus).reduce((sum, value) => sum + value, 0)
  const openAlarms = alarms.filter((alarm) => alarm.status === 'open')

  return (
    <div className="compact">
      <header className="compact-head">
        <div>
          <strong>{park?.name ?? '园区数字孪生'}</strong>
          <span>{park?.full_name ?? '正在连接底座'}</span>
        </div>
        <div className="compact-head-right">
          <Clock />
          <button className="top-action" onClick={onOpen3D}>
            三维视图
          </button>
        </div>
      </header>

      <section className="compact-section">
        <div className="compact-kpis">
          {overview
            ? overview.kpi.map((item) => (
                <article className={`compact-kpi kpi-${item.tone}`} key={item.key}>
                  <span>{item.label}</span>
                  <div>
                    <strong>{item.value}</strong>
                    <em>{item.unit}</em>
                  </div>
                  <small>{item.sub}</small>
                </article>
              ))
            : // 占位卡片与真实卡片同高: 数据到位时只有文字变化, 版面不跳动
              Array.from({ length: 6 }).map((_, index) => (
                <article className="compact-kpi is-skeleton" key={index} aria-hidden>
                  <span>&nbsp;</span>
                  <div>
                    <strong>—</strong>
                    <em>&nbsp;</em>
                  </div>
                  <small>&nbsp;</small>
                </article>
              ))}
        </div>
      </section>

      <section className="compact-section">
        <div className="compact-title">
          <h2>设备状态</h2>
          <span>{totalDevices} 台</span>
        </div>
        <div className="compact-status">
          {(['normal', 'warning', 'alarm', 'offline'] as DeviceStatus[]).map((key) => (
            <div key={key}>
              <i style={{ background: STATUS_HEX[key] }} />
              <span>{STATUS_LABEL[key]}</span>
              <strong>{deviceStatus[key] ?? 0}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="compact-section">
        <div className="compact-title">
          <h2>待处置告警</h2>
          <span>{openAlarms.length} 条</span>
        </div>
        {!loaded ? (
          <div className="compact-alarm-list">
            {[0, 1].map((index) => (
              <div className="compact-alarm is-skeleton" key={index} aria-hidden>
                <div className="compact-alarm-main">
                  <strong>&nbsp;</strong>
                </div>
                <div className="compact-alarm-meta">
                  <span>&nbsp;</span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {loaded && openAlarms.length === 0 ? <p className="empty">暂无待处置告警</p> : null}
        <div className="compact-alarm-list">
          {openAlarms.slice(0, 12).map((alarm) => (
            <div className={`compact-alarm compact-alarm-${alarm.level}`} key={alarm.id}>
              <div className="compact-alarm-main">
                <em>{LEVEL_TEXT[alarm.level]}</em>
                <strong>{alarm.title}</strong>
              </div>
              <div className="compact-alarm-meta">
                <span>
                  {alarm.value}
                  {alarm.unit} / 阈值 {alarm.threshold}
                  {alarm.unit}
                </span>
                <span>{alarm.ts.slice(5, 16).replace('T', ' ')}</span>
                <button onClick={() => void ack(alarm.id)}>确认</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="compact-section">
        <div className="compact-title">
          <h2>楼栋</h2>
          <span>{buildings.length} 栋</span>
        </div>
        <div className="compact-buildings">
          {buildings.map((item) => (
            <button
              key={item.id}
              className={`compact-building${detail?.id === item.id ? ' is-open' : ''}`}
              onClick={() => void openBuilding(item.id)}
            >
              <span className="compact-building-name">
                {item.name}
                <em>
                  {item.type_label} · {item.floors}F · {Math.round(item.energy_kwh_today)} kWh
                </em>
              </span>
              <span className="compact-building-num">{item.device_count} 台</span>
              {item.alarm_count > 0 ? (
                <span className="compact-badge">{item.alarm_count}</span>
              ) : null}
            </button>
          ))}
        </div>
        {busy ? <p className="empty">正在读取 {busy} 的设备清单…</p> : null}
      </section>

      {detail ? (
        <section className="compact-section compact-devices">
          <div className="compact-title">
            <h2>{detail.name} · 设备</h2>
            <button className="ghost" onClick={() => setDetail(null)}>
              收起
            </button>
          </div>
          {detail.devices.map((device) => (
            <div className="compact-device" key={device.id}>
              <i style={{ background: STATUS_HEX[device.status] }} />
              <span>{device.name}</span>
              <em>
                {device.metric.value} {device.metric.unit}
              </em>
            </div>
          ))}
        </section>
      ) : null}

      {error ? <p className="compact-error">{error.slice(0, 120)}</p> : null}

      <footer className="compact-foot">
        轻量视图 · 不加载三维引擎
        <button className="ghost" onClick={onOpen3D}>
          仍要加载三维场景
        </button>
      </footer>
    </div>
  )
}
