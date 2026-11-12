import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api/client'
import type { HoverInfo, TwinScene } from './cesium/scene'
import { Inspector } from './components/Inspector'
import { KpiStrip } from './components/KpiStrip'
import { LayerPanel } from './components/LayerPanel'
import { LightweightPanel } from './components/LightweightPanel'
import { SearchBox } from './components/SearchBox'
import { StatusBar } from './components/StatusBar'
import { TopBar } from './components/TopBar'
import { useDirectory } from './hooks/useDirectory'
import { useLayerSet } from './hooks/useLayerSet'
import { useLiveData } from './hooks/useLiveData'
import { useSceneBootstrap } from './hooks/useSceneBootstrap'
import { useShell } from './hooks/useShell'
import { describe } from './lib/describe'
import type {
  Alarm,
  BuildingDetail,
  DeviceProps,
  EnergySummary,
  LayerCatalog,
  LightweightReport,
  LightweightStats,
  Overview,
  Park,
  TilesetInfo,
} from './types'

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<TwinScene | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const coordRef = useRef<HTMLSpanElement>(null)
  const visibilityRef = useRef<Record<string, boolean>>({})
  // 请求令牌: 快速连点/连续切 LOD 时只认最后一次请求, 避免旧响应覆盖新数据
  const buildingToken = useRef(0)
  const deviceToken = useRef(0)
  const toastTimer = useRef(0)
  const morphTimer = useRef(0)
  // 深链只处理一次: effect 依赖的函数身份变化时不重复飞入/重置剖切
  const deepLinkDone = useRef(false)

  const [park, setPark] = useState<Park | null>(null)
  const [catalog, setCatalog] = useState<LayerCatalog | null>(null)
  const [visibility, setVisibility] = useState<Record<string, boolean>>({})
  const [stats, setStats] = useState<Record<string, LightweightStats>>({})
  const [report, setReport] = useState<LightweightReport | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [energy, setEnergy] = useState<EnergySummary | null>(null)
  const [alarms, setAlarms] = useState<Alarm[]>([])
  const [building, setBuilding] = useState<BuildingDetail | null>(null)
  const [device, setDevice] = useState<DeviceProps | null>(null)
  const [floorClip, setFloorClip] = useState(1)
  const [lod, setLod] = useState(1)
  const [mode, setMode] = useState<'3d' | '2d'>('3d')
  const [kpiCollapsed, setKpiCollapsed] = useState(false)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [morphing, setMorphing] = useState(false)
  const [layerLoading, setLayerLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [shell, setShell] = useState<TilesetInfo | null>(null)
  const [shellMode, setShellMode] = useState<'model' | 'vector'>('vector')
  const [shellLoading, setShellLoading] = useState(false)
  const [shellProgress, setShellProgress] = useState(0)
  const [hover, setHover] = useState<{ title: string; sub: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const notify = useCallback((text: string) => {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3200)
  }, [])

  // 定时器会在卸载后继续跑, 不清理就会往已卸载的组件里 setState
  useEffect(
    () => () => {
      window.clearTimeout(toastTimer.current)
      window.clearTimeout(morphTimer.current)
    },
    [],
  )

  // ------------------------------------------------------------ 选择动作
  const loadBuilding = useCallback(async (id: string) => {
    const token = ++buildingToken.current
    setDetailLoading(true)
    try {
      const detail = await api.building(id)
      if (token !== buildingToken.current) return
      setBuilding(detail)
      setDevice(null)
      setFloorClip(detail.floors)
      sceneRef.current?.showDeviceModel(null)
      sceneRef.current?.selectBuilding(id)
      sceneRef.current?.resetFloorClip(id)
      sceneRef.current?.focusBuilding(id)
    } catch (err) {
      if (token === buildingToken.current) setError(String(err))
    } finally {
      if (token === buildingToken.current) setDetailLoading(false)
    }
  }, [])

  const loadDevice = useCallback(async (id: string) => {
    const token = ++deviceToken.current
    setDetailLoading(true)
    try {
      const detail = await api.device(id)
      if (token !== deviceToken.current) return
      setDevice(detail)
      // 高模只有 2~3m, 选中后贴到 46m 视距才能看清; 相机与模型一起进场
      sceneRef.current?.showDeviceModel(id)
      sceneRef.current?.focusDevice(id)
    } catch (err) {
      if (token === deviceToken.current) setError(String(err))
    } finally {
      if (token === deviceToken.current) setDetailLoading(false)
    }
  }, [])

  const resetSelection = useCallback(() => {
    buildingToken.current += 1
    deviceToken.current += 1
    setDetailLoading(false)
    setDevice(null)
    setBuilding(null)
    const scene = sceneRef.current
    // 从设备近景退出时把相机拉回园区全景: 否则相机会停在该楼体块内部, 整屏都是楼栋色
    const wasInspecting = scene?.hasDeviceModel ?? false
    scene?.showDeviceModel(null)
    scene?.selectBuilding(null)
    if (wasInspecting) scene?.flyHome()
  }, [])

  /** 回到园区全景: 清掉选择再飞, 否则相机会停在楼里 */
  const goHome = useCallback(() => {
    resetSelection()
    sceneRef.current?.flyHome()
  }, [resetSelection])

  const closeDetail = useCallback(() => {
    if (device) {
      deviceToken.current += 1
      setDetailLoading(false)
      setDevice(null)
      sceneRef.current?.showDeviceModel(null)
      // 回到楼栋详情: 机位也应退回该楼的室外视角, 而不是停在设备近景里
      if (building) sceneRef.current?.focusBuilding(building.id)
      else sceneRef.current?.flyHome()
      return
    }
    buildingToken.current += 1
    setDetailLoading(false)
    setBuilding(null)
    sceneRef.current?.selectBuilding(null)
  }, [device, building])

  /**
   * 告警定位: 直接把相机贴到告警设备并打开面板.
   * 没有设备 id 的告警退回所属楼栋 —— 至少能落到出事的楼, 不用再去园区里找。
   */
  const locateAlarm = useCallback(
    (alarm: Alarm) => {
      if (alarm.device_id) void loadDevice(alarm.device_id)
      else if (alarm.building_id) void loadBuilding(alarm.building_id)
    },
    [loadBuilding, loadDevice],
  )

  // ------------------------------------------------------------ 无重绘的鼠标反馈
  const onHover = useCallback((info: HoverInfo | null) => {
    if (!info) {
      setHover(null)
      return
    }
    const element = tipRef.current
    if (element) element.style.transform = `translate(${info.x + 16}px, ${info.y + 14}px)`
    setHover((previous) =>
      previous && previous.title === info.title && previous.sub === info.sub
        ? previous
        : { title: info.title, sub: info.sub },
    )
  }, [])

  const onCursor = useCallback((pos: { lon: number; lat: number } | null) => {
    if (coordRef.current) {
      coordRef.current.textContent = pos
        ? `E ${pos.lon.toFixed(6)}  N ${pos.lat.toFixed(6)}`
        : 'E —  N —'
    }
  }, [])

  /**
   * 视图模式切换.
   * useCallback 是必需的: 深链 effect 依赖它, 每次渲染新建函数会让 effect 反复执行,
   * 表现为 URL 带 ?building= 时楼栋被反复重新拉取/重置剖切。
   */
  const changeMode = useCallback(
    (next: '3d' | '2d') => {
      if (next === mode) return
      const scene = sceneRef.current
      setMode(next)
      if (!scene) return
      // 切换是同步的, 遮罩只负责「给个最短展示时间」, 不能把切换本身放进定时器
      setMorphing(true)
      scene.morph(next)
      window.clearTimeout(morphTimer.current)
      morphTimer.current = window.setTimeout(() => setMorphing(false), 260)
    },
    [mode],
  )

  // ------------------------------------------------------------ 初始化场景
  useSceneBootstrap({
    containerRef,
    sceneRef,
    visibilityRef,
    onPark: setPark,
    onCatalog: setCatalog,
    onLod: setLod,
    onVisibility: setVisibility,
    onReady: setReady,
    onError: setError,
    loadBuilding,
    loadDevice,
    resetSelection,
    onHover,
    onCursor,
  })

  // ------------------------------------------------------------ 按 LOD 拉取图层
  useLayerSet({
    ready,
    catalog,
    lod,
    sceneRef,
    visibilityRef,
    onStats: setStats,
    onLoading: setLayerLoading,
    onError: setError,
    notify,
  })

  // ------------------------------------------------------------ 三维外壳 (3D Tiles)
  useShell({
    ready,
    sceneRef,
    notify,
    onInfo: setShell,
    onMode: setShellMode,
    onLoading: setShellLoading,
    onProgress: setShellProgress,
  })

  // ------------------------------------------------------------ 目录与快捷键
  const { entries, buildingNames, loaded: directoryLoaded, ensureDevices } = useDirectory(ready)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // 输入框 / 文本域里不劫持按键, 否则搜索框没法打字
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }

      if (event.key === 'Escape') {
        closeDetail()
        return
      }
      if (event.key === 'f' || event.key === 'F') {
        goHome()
        return
      }
      if (event.key === '1' || event.key === '2' || event.key === '3') {
        setLod(Number(event.key) - 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeDetail, goHome])

  // ------------------------------------------------------------ 深链: /?mode=2d&building=B01&floor=4
  useEffect(() => {
    if (!ready || deepLinkDone.current) return
    deepLinkDone.current = true
    const params = new URLSearchParams(location.search)
    // 走与按钮一致的切换流程, 保证同样有过渡遮罩
    if (params.get('mode') === '2d') changeMode('2d')
    const target = params.get('building')
    const floorParam = params.get('floor')
    if (target) {
      void loadBuilding(target).then(() => {
        const floor = floorParam === null ? Number.NaN : Number(floorParam)
        if (Number.isFinite(floor) && floor > 0) {
          setFloorClip(floor)
          sceneRef.current?.setFloorClip(target, floor)
        }
      })
    }
  }, [ready, loadBuilding, changeMode])

  // ------------------------------------------------------------ 实时通道 + 态势轮询
  const conn = useLiveData({
    ready,
    sceneRef,
    setDevice,
    setBuilding,
    setAlarms,
    setOverview,
    setEnergy,
    setReport,
  })

  // ------------------------------------------------------------ 交互回调
  const toggleLayer = (key: string) => {
    const next = !(visibility[key] ?? true)
    const merged = { ...visibility, [key]: next }
    visibilityRef.current = merged
    setVisibility(merged)
    sceneRef.current?.setLayerVisible(key, next)
  }

  const setAllLayers = (visible: boolean) => {
    const merged = Object.fromEntries(Object.keys(visibility).map((key) => [key, visible]))
    visibilityRef.current = merged
    setVisibility(merged)
    for (const key of Object.keys(merged)) sceneRef.current?.setLayerVisible(key, visible)
  }

  const changeShellMode = (next: 'model' | 'vector') => {
    setShellMode(next)
    sceneRef.current?.setShellMode(next)
  }

  const handleFloorClip = (floor: number) => {
    if (!building) return
    setFloorClip(floor)
    sceneRef.current?.setFloorClip(building.id, floor)
  }

  const resetFloor = () => {
    if (!building) return
    setFloorClip(building.floors)
    sceneRef.current?.resetFloorClip(building.id)
  }

  const ackAlarm = async (id: string) => {
    try {
      await api.ack(id)
      setAlarms((previous) =>
        previous.map((alarm) => (alarm.id === id ? { ...alarm, status: 'acked' as const } : alarm)),
      )
    } catch (err) {
      setError(describe(err))
    }
  }

  const runCommand = async (payload: { action: string; value?: number }) => {
    if (!device) return
    setBusy(true)
    try {
      await api.command(device.id, payload)
      setDevice(await api.device(device.id))
    } catch (err) {
      setError(describe(err))
    } finally {
      setBusy(false)
    }
  }

  const activeLod = catalog?.lods.find((item) => item.lod === lod)
  const deviceBuildingId = device?.building_id ?? null

  return (
    <div className={`app${kpiCollapsed ? ' is-kpi-collapsed' : ''}`}>
      <div className="viewport" ref={containerRef} />
      <div className="vignette" aria-hidden />

      <TopBar
        park={park}
        mode={mode}
        onMode={changeMode}
        lod={lod}
        lods={catalog?.lods ?? []}
        onLod={setLod}
        conn={conn}
        shellAvailable={Boolean(shell?.available)}
        shellMode={shellMode}
        onShellMode={changeShellMode}
        onHome={goHome}
      />

      <div className="panel panel-left">
        <SearchBox
          entries={entries}
          loaded={directoryLoaded}
          onDemand={ensureDevices}
          onPickBuilding={(id) => void loadBuilding(id)}
          onPickDevice={(id) => void loadDevice(id)}
        />
        <LayerPanel
          layers={catalog?.layers ?? []}
          lod={activeLod}
          visibility={visibility}
          onToggle={toggleLayer}
          onAll={setAllLayers}
        />
        <LightweightPanel stats={stats} report={report} lod={lod} onLod={setLod} />
      </div>

      <Inspector
        building={building}
        device={device}
        overview={overview}
        energy={energy}
        alarms={alarms}
        floorClip={floorClip}
        busy={busy}
        loading={detailLoading}
        buildingName={deviceBuildingId ? buildingNames[deviceBuildingId] : undefined}
        onClose={closeDetail}
        onAck={ackAlarm}
        onLocate={locateAlarm}
        onFloorClip={handleFloorClip}
        onResetFloor={resetFloor}
        onSelectDevice={(id) => void loadDevice(id)}
        onBackToBuilding={deviceBuildingId ? () => void loadBuilding(deviceBuildingId) : undefined}
        onCommand={runCommand}
      />

      <KpiStrip
        kpi={overview?.kpi ?? []}
        updatedAt={overview?.updated_at}
        collapsed={kpiCollapsed}
        onToggle={() => setKpiCollapsed((value) => !value)}
      />

      {layerLoading || morphing || shellLoading ? (
        <div
          // 只有视图切换(全屏重投影)才值得遮罩; 图层与瓦片都是渐进加载,
          // 全屏模糊会把已经可用的面板一起糊掉, 反而像"卡住了"
          className={`map-loading${morphing ? '' : ' is-slim'}`}
          role="status"
          aria-live="polite"
        >
          <div className="loading-box">
            <span className="spinner" aria-hidden />
            <span>
              {morphing
                ? '正在切换视图'
                : shellLoading
                  ? `正在加载三维模型 ${shellProgress}%`
                  : '正在加载园区数据'}
            </span>
          </div>
        </div>
      ) : null}

      <StatusBar
        coordRef={coordRef}
        backend={park?.backend ?? 'memory'}
        conn={conn}
        lodLabel={activeLod?.label ?? '—'}
        deviceCount={
          overview?.device_status
            ? Object.values(overview.device_status).reduce((a, b) => a + b, 0)
            : 0
        }
      />

      <div className={`map-tip${hover ? '' : ' is-hidden'}`} ref={tipRef}>
        <strong>{hover?.title ?? ''}</strong>
        <span>{hover?.sub ?? ''}</span>
      </div>

      {toast ? <div className="toast">{toast}</div> : null}

      {error ? (
        <div className="error-toast" title={error} onClick={() => setError(null)}>
          {error.split('\n')[0]}
        </div>
      ) : null}

      {!ready && !error ? <div className="boot-mask">正在装载园区孪生场景…</div> : null}
    </div>
  )
}
