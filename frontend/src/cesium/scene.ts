import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { DeviceStatus, FeatureCollection, GeoFeature, Park, TelemetryItem } from '../types'
import { DeviceModelLayer } from '../three/deviceLayer'
import { BUILDING_HEX, GREEN_HEX, PIPE_HEX, STATUS_HEX } from './style'

export interface HoverInfo {
  x: number
  y: number
  title: string
  sub: string
}

export interface SceneCallbacks {
  onPickBuilding: (id: string) => void
  onPickDevice: (id: string) => void
  onBlank: () => void
  onHover: (info: HoverInfo | null) => void
  onCursor: (pos: { lon: number; lat: number } | null) => void
}

interface LayerGroup {
  entities: Cesium.Entity[]
  collections: Cesium.PointPrimitiveCollection[]
  visible: boolean
}

interface BuildingMeta {
  name: string
  type: string
  floors: number
  floorHeight: number
  height: number
  color: string
}

interface DeviceMeta {
  type: string
  status: DeviceStatus
  floor: number
  buildingId: string | null
}

const BASE_ALPHA = 0.62
const SELECT_HEX = '#8FE9FF'
/**
 * 矢量体块比三维外壳高 5cm.
 * 模型模式下体块是「隐形拾取代理」(alpha=0), 与外壳共面会导致拾取深度打架,
 * 抬 5cm 让代理稳定胜出; 800m 视距下 5cm 不足一个像素, 肉眼看不出.
 */
const PICK_LIFT = 0.05

/** 相机高度下限/上限: Cesium 的 zoomDistance 与滚轮推拉的裁剪共用同一组值 */
const MIN_ZOOM_HEIGHT = 6
const MAX_ZOOM_HEIGHT = 5200
/** 滚轮一格(≈100px deltaY)推拉视距的固定比例: 远近手感一致, 又不会一格跳半屏 */
const WHEEL_ZOOM_STEP = 0.12

/**
 * 设备高模的观察参数: dist 是水平退距(米), lift 是取景中心相对安装面的高度(米)。
 * 两者都随模型体量走 —— 冷水机组 3.7m 长要退 30m, 地磁车位 0.2m 退 8m 就够;
 * 3.4m 的摄像机立杆则要把取景中心抬到杆腰, 否则杆顶会被切出画面。
 */
const DEVICE_VIEW: Record<string, { dist: number; lift: number }> = {
  hvac: { dist: 30, lift: 0.9 },
  elevator: { dist: 24, lift: 0.9 },
  water: { dist: 20, lift: 0.7 },
  camera: { dist: 18, lift: 1.9 },
  light: { dist: 20, lift: 2.1 },
  meter: { dist: 13, lift: 0.7 },
  charge: { dist: 13, lift: 0.9 },
  env: { dist: 12, lift: 1.1 },
  fire: { dist: 9, lift: 0.15 },
  parking: { dist: 8, lift: 0.1 },
}

const DEVICE_PIXEL_RATIO = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
/** 低像素比屏做 1.25 倍超采样, SDF 文字与折线边缘明显更柔和 */
const SUPERSAMPLE = DEVICE_PIXEL_RATIO < 1.5 ? 1.25 : 1
/** 开启设备像素比渲染后, 线宽/点径/标签内边距都按帧缓冲像素计, 需按此补偿 */
const PX_SCALE = DEVICE_PIXEL_RATIO * SUPERSAMPLE
const px = (value: number): number => value * PX_SCALE

function ringOf(geometry: GeoFeature['geometry']): number[][] {
  const coords = geometry.coordinates as number[][][]
  return coords?.[0] ?? []
}

function lineOf(geometry: GeoFeature['geometry']): number[][] {
  return (geometry.coordinates as number[][]) ?? []
}

function pointOf(geometry: GeoFeature['geometry']): number[] {
  return (geometry.coordinates as number[]) ?? [0, 0, 0]
}

function flatten(ring: number[][], height: number): number[] {
  return ring.flatMap(([lon, lat]) => [lon, lat, height])
}

/** contentAvailable 未进入官方类型声明, 这里局部补一下, 用于统计瓦片加载进度 */
type TileNode = Cesium.Cesium3DTile & { contentAvailable?: boolean }

function countTiles(tile: TileNode): { total: number; ready: number } {
  let total = 1
  let ready = tile.contentAvailable ? 1 : 0
  for (const child of tile.children ?? []) {
    const sub = countTiles(child as TileNode)
    total += sub.total
    ready += sub.ready
  }
  return { total, ready }
}

/**
 * Cesium 场景封装。
 *
 * 为什么是 Cesium 而不是 Three.js:
 *   园区级数字孪生的输入是「带地理坐标的 GIS 数据」, 依赖坐标系、瓦片调度、
 *   高程与矢量拾取。Three.js 缺这一整层, 自研等于重写半个 Cesium。
 *
 * 为什么不做 Three.js 混渲染:
 *   12 栋建筑 + 200 个设备点位, 拉伸体块 + 点图元已足够; 等真的接入设备级
 *   高模 (冷水机组/风机) 再以自定义 Primitive 挂进来, 见 docs/01。
 */
export class TwinScene {
  readonly viewer: Cesium.Viewer

  private callbacks: SceneCallbacks
  private groundHeight: number
  private groups = new Map<string, LayerGroup>()
  private buildingEntities = new Map<string, Cesium.Entity>()
  private buildingRings = new Map<string, number[][]>()
  private buildingMeta = new Map<string, BuildingMeta>()
  private devicePoints = new Map<string, Cesium.Entity>()
  private deviceMeta = new Map<string, DeviceMeta>()
  private modelLayer: DeviceModelLayer | null = null
  private modelDevice: string | null = null
  private ghostBuilding: string | null = null
  private modelStatus: DeviceStatus | null = null
  private modelFailed = false
  private handler: Cesium.ScreenSpaceEventHandler
  private hovered: string | null = null
  private selected: string | null = null
  private slab: Cesium.Entity | null = null
  private homeCenter: [number, number] = [0, 0]
  private homeHeight = 800
  private homeHeading = 0
  private homePitch = -40
  private parkRect: Cesium.Rectangle | null = null
  private clip: { id: string; floor: number } | null = null
  private tileset: Cesium.Cesium3DTileset | null = null
  private clipCollection: Cesium.ClippingPlaneCollection | null = null
  private shellMode: 'vector' | 'model' = 'vector'
  /** 每帧同步高模相机的解绑函数 (Cesium.Event.addEventListener 的返回值) */
  private removePostRender: (() => void) | null = null
  /** 瓦片进度监听与裁剪面集合都要跟着 tileset 一起释放, 否则 HMR/切页后残留 */
  private removeTilesetListeners: Array<() => void> = []
  /** 同一状态的点位样式是常量, 全场景共用, 避免每次推送重建 Color/ConstantProperty */
  private deviceStyleCache = new Map<
    DeviceStatus,
    { color: Cesium.ConstantProperty; pixelSize: Cesium.ConstantProperty }
  >()
  /** 悬停拾取按帧合并: 一次鼠标移动最多触发一次拾取 */
  private hoverFrame = 0
  private pendingHover: { x: number; y: number } | null = null
  /** 拾取复用的屏幕坐标, 避免每次移动新建 Cartesian2 */
  private scratchScreen = new Cesium.Cartesian2()
  /** 滚轮推拉复用的「地表法线」临时对象 */
  private scratchUp = new Cesium.Cartesian3()

  constructor(container: HTMLElement, park: Park, callbacks: SceneCallbacks) {
    this.callbacks = callbacks
    this.groundHeight = park.ground_altitude ?? 0
    this.setHome(park)

    // 不依赖 Cesium ion: 无 token 也能跑; 底图默认关闭 (数据轻量化优先)
    Cesium.Ion.defaultAccessToken = ''

    this.viewer = new Cesium.Viewer(container, {
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      baseLayer: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      shouldAnimate: false,
      // 默认 true 会忽略 devicePixelRatio, 高分屏上 SDF 文字与体块边缘会发虚/出锯齿
      useBrowserRecommendedResolution: false,
    })

    const scene = this.viewer.scene
    // 比面板再暗一档而不是纯黑: 画布与浮层之间要有层次, 纯黑会让面板边缘"发飘"
    scene.backgroundColor = Cesium.Color.fromCssColorString('#070e17')
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#081019')
    scene.globe.showGroundAtmosphere = false
    scene.globe.enableLighting = false
    scene.globe.depthTestAgainstTerrain = false
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false
    scene.fog.enabled = false
    scene.postProcessStages.fxaa.enabled = true
    this.viewer.resolutionScale = SUPERSAMPLE
    if (scene.skyBox) scene.skyBox.show = false
    if (scene.sun) scene.sun.show = false
    if (scene.moon) scene.moon.show = false
    // 6m 而不是 25m: 设备高模的观察机位在 20~30m, Cesium 会把低于该下限的机位
    // 沿视线抬回下限高度, 表现为「相机没到位、设备沉到画面外」
    scene.screenSpaceCameraController.minimumZoomDistance = MIN_ZOOM_HEIGHT
    scene.screenSpaceCameraController.maximumZoomDistance = MAX_ZOOM_HEIGHT
    this.bindZoom()

    const credits = this.viewer.cesiumWidget.creditContainer
    if (credits instanceof HTMLElement) credits.style.display = 'none'

    this.drawSite(park)
    this.createModelLayer(container, park)
    // 高模图层跟在 Cesium 每帧渲染之后同步相机, 保证两台相机永远同一视角
    this.removePostRender = scene.postRender.addEventListener(() => {
      this.modelLayer?.sync(this.viewer.camera, scene.mode)
    })
    this.handler = new Cesium.ScreenSpaceEventHandler(scene.canvas)
    this.bindInput()
    this.applyHome(true)

    // 带 ?debug 时暴露实例, 便于在控制台查相机/图层状态; 正常访问不挂任何全局
    if (new URLSearchParams(window.location.search).has('debug')) {
      ;(window as unknown as { __twin?: TwinScene }).__twin = this
    }
  }

  /** 高模层是可降级能力: WebGL2/显卡不支持时整层跳过, 主场景照常 */
  private createModelLayer(container: HTMLElement, park: Park): void {
    try {
      this.modelLayer = new DeviceModelLayer(container, park.center)
    } catch (err) {
      this.modelFailed = true
      console.warn('[twin] 设备高模图层初始化失败, 仅保留点位', err)
    }
  }

  // ---------------------------------------------------------------- 基础场景
  private drawSite(park: Park): void {
    const ring = park.boundary?.[0] ?? []
    if (ring.length < 3) return
    this.viewer.entities.add({
      id: 'site:ground',
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(
          Cesium.Cartesian3.fromDegreesArrayHeights(flatten(ring, this.groundHeight - 0.6)),
        ),
        height: this.groundHeight - 0.6,
        material: Cesium.Color.fromCssColorString('#0C1926').withAlpha(0.97),
      },
    })
    this.viewer.entities.add({
      id: 'site:edge',
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(
          flatten(ring, this.groundHeight + 0.1),
        ),
        width: px(2),
        arcType: Cesium.ArcType.NONE,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.24,
          color: Cesium.Color.fromCssColorString('#35C3FF').withAlpha(0.85),
        }),
      },
    })
  }

  private group(key: string): LayerGroup {
    let group = this.groups.get(key)
    if (!group) {
      group = { entities: [], collections: [], visible: true }
      this.groups.set(key, group)
    }
    return group
  }

  private clearGroup(key: string): LayerGroup {
    const group = this.group(key)
    for (const entity of group.entities) this.viewer.entities.remove(entity)
    for (const collection of group.collections) this.viewer.scene.primitives.remove(collection)
    group.entities = []
    group.collections = []
    return group
  }

  // ---------------------------------------------------------------- 图层装载
  setLayer(key: string, fc: FeatureCollection): void {
    const visible = this.groups.get(key)?.visible ?? true
    const group = this.clearGroup(key)
    switch (key) {
      case 'boundary':
        this.loadBoundary(group, fc)
        break
      case 'buildings':
        this.loadBuildings(group, fc)
        break
      case 'roads':
        this.loadRoads(group, fc)
        break
      case 'green':
        this.loadGreen(group, fc)
        break
      case 'trees':
        this.loadTrees(group, fc)
        break
      case 'pipes':
        this.loadPipes(group, fc)
        break
      case 'devices':
        this.loadDevices(group, fc)
        break
      default:
        break
    }
    group.visible = visible
    this.applyVisibility(key, visible)
  }

  private loadBoundary(group: LayerGroup, fc: FeatureCollection): void {
    for (const feature of fc.features) {
      const ring = ringOf(feature.geometry)
      if (ring.length < 3) continue
      group.entities.push(
        this.viewer.entities.add({
          id: `boundary:${String(feature.properties.id)}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(
              flatten(ring, this.groundHeight + 0.35),
            ),
            width: px(1.5),
            arcType: Cesium.ArcType.NONE,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString('#35C3FF').withAlpha(0.55),
              dashLength: px(24),
            }),
          },
        }),
      )
    }
  }

  private loadBuildings(group: LayerGroup, fc: FeatureCollection): void {
    this.buildingEntities.clear()
    this.buildingRings.clear()
    this.buildingMeta.clear()

    for (const feature of fc.features) {
      const props = feature.properties as Record<string, unknown>
      const id = String(props.id)
      const ring = ringOf(feature.geometry)
      if (ring.length < 3) continue

      const height = Number(props.height ?? 20)
      const floors = Number(props.floors ?? Math.max(1, Math.round(height / 4)))
      const floorHeight = Number(props.floor_height ?? height / floors)
      const color = String(props.color ?? BUILDING_HEX[String(props.type)] ?? '#2E7DF7')

      // 标签只展示当前 LOD 里真实存在的属性:
      // 概览只有名称, 标准多出层数, 精细再带上建筑面积 —— 精度切换因此看得见
      const tags: string[] = []
      if (props.floors !== undefined) tags.push(`${floors}F`)
      if (props.gfa_m2 !== undefined) tags.push(`${(Number(props.gfa_m2) / 10000).toFixed(1)}万㎡`)
      const labelText = tags.length
        ? `${String(props.name ?? id)}  ${tags.join(' · ')}`
        : String(props.name ?? id)
      const base = this.baseZ()
      const top = base + height
      const lon = ring.reduce((sum, p) => sum + p[0], 0) / ring.length
      const lat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length

      const entity = this.viewer.entities.add({
        id: `building:${id}`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat, top + 3),
        polygon: {
          // 轻量化后的环只保留 x/y, 高程由 height / extrudedHeight 控制
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(ring.flatMap(([lon, lat]) => [lon, lat])),
          ),
          height: base,
          extrudedHeight: top,
          closeTop: true,
          closeBottom: false,
          material: Cesium.Color.fromCssColorString(color).withAlpha(BASE_ALPHA),
        },
        label: {
          text: labelText,
          font: '500 15px "PingFang SC", "Microsoft YaHei", system-ui',
          fillColor: Cesium.Color.fromCssColorString('#E4F2FE'),
          style: Cesium.LabelStyle.FILL,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#061019').withAlpha(0.78),
          backgroundPadding: new Cesium.Cartesian2(px(8), px(6)),
          pixelOffset: new Cesium.Cartesian2(0, px(-7)),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          // 上限要盖住相机最远距离(5200), 否则拉到 2600m 时全部标签「啪」地消失
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5200),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })

      group.entities.push(entity)
      group.entities.push(
        this.viewer.entities.add({
          id: `building-outline:${id}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(flatten(ring, top)),
            width: px(1.4),
            arcType: Cesium.ArcType.NONE,
            material: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
          },
        }),
      )

      this.buildingEntities.set(id, entity)
      this.buildingRings.set(id, ring)
      this.buildingMeta.set(id, {
        name: String(props.name ?? id),
        type: String(props.type ?? 'office'),
        floors,
        floorHeight,
        height,
        color,
      })
    }

    // 切 LOD 会重建实体, 这里把选中态与剖切高度补回来,
    // 否则面板显示「显示至 5F」但场景已恢复整体块, 看起来就是数据不对
    if (this.selected) this.paintBuilding(this.selected)
    if (this.clip) this.setFloorClip(this.clip.id, this.clip.floor)
  }

  private loadRoads(group: LayerGroup, fc: FeatureCollection): void {
    for (const feature of fc.features) {
      const props = feature.properties as Record<string, unknown>
      const coords = lineOf(feature.geometry)
      const main = props.level === 'main'
      group.entities.push(
        this.viewer.entities.add({
          id: `road:${String(props.id)}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(
              flatten(coords, this.groundHeight + 0.16),
            ),
            width: px(main ? 11 : 6),
            arcType: Cesium.ArcType.NONE,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: main ? 0.14 : 0.08,
              color: Cesium.Color.fromCssColorString(main ? '#2C4257' : '#22313F').withAlpha(0.95),
            }),
          },
        }),
      )
    }
  }

  private loadGreen(group: LayerGroup, fc: FeatureCollection): void {
    for (const feature of fc.features) {
      const props = feature.properties as Record<string, unknown>
      const ring = ringOf(feature.geometry)
      if (ring.length < 3) continue
      const kind = String(props.kind ?? 'lawn')
      const color = GREEN_HEX[kind] ?? GREEN_HEX.lawn
      group.entities.push(
        this.viewer.entities.add({
          id: `green:${String(props.id)}`,
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(ring.flatMap(([lon, lat]) => [lon, lat])),
            ),
            height: this.groundHeight + (kind === 'water' ? 0.08 : 0.05),
            material: Cesium.Color.fromCssColorString(color).withAlpha(
              kind === 'plaza' ? 0.9 : 0.78,
            ),
          },
        }),
      )
    }
  }

  private loadTrees(group: LayerGroup, fc: FeatureCollection): void {
    for (const feature of fc.features) {
      const props = feature.properties as Record<string, unknown>
      const [lon, lat, alt] = pointOf(feature.geometry)
      group.entities.push(
        this.viewer.entities.add({
          id: `tree:${String(props.id)}`,
          position: Cesium.Cartesian3.fromDegrees(lon, lat, alt ?? this.groundHeight + 5),
          point: {
            pixelSize: px(Number(props.crown ?? 3) + 1.5),
            color: Cesium.Color.fromCssColorString('#2F7D4B').withAlpha(0.95),
            outlineColor: Cesium.Color.fromCssColorString('#0B1B12').withAlpha(0.8),
            outlineWidth: px(1),
            scaleByDistance: new Cesium.NearFarScalar(150, 1.5, 3500, 0.4),
          },
        }),
      )
    }
  }

  private loadPipes(group: LayerGroup, fc: FeatureCollection): void {
    for (const feature of fc.features) {
      const props = feature.properties as Record<string, unknown>
      const coords = lineOf(feature.geometry)
      const color = String(props.color ?? PIPE_HEX[String(props.type)] ?? '#2E9BFF')
      group.entities.push(
        this.viewer.entities.add({
          id: `pipe:${String(props.id)}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(
              flatten(coords, this.groundHeight + 0.6),
            ),
            width: px(2),
            arcType: Cesium.ArcType.NONE,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
              dashLength: px(14),
            }),
          },
        }),
      )
    }
  }

  /**
   * 同一状态的点位共用一份属性对象: 颜色与点径都是常量,
   * 200 台设备没必要各建一份 ConstantProperty/Color.
   */
  private deviceStyle(status: DeviceStatus): {
    color: Cesium.ConstantProperty
    pixelSize: Cesium.ConstantProperty
  } {
    let style = this.deviceStyleCache.get(status)
    if (!style) {
      style = {
        color: new Cesium.ConstantProperty(
          Cesium.Color.fromCssColorString(STATUS_HEX[status] ?? STATUS_HEX.normal).withAlpha(0.92),
        ),
        pixelSize: new Cesium.ConstantProperty(px(status === 'alarm' ? 12 : 7)),
      }
      this.deviceStyleCache.set(status, style)
    }
    return style
  }

  private loadDevices(group: LayerGroup, fc: FeatureCollection): void {
    this.devicePoints.clear()
    this.deviceMeta.clear()
    for (const feature of fc.features) {
      const props = feature.properties as Record<string, unknown>
      const [lon, lat, alt] = pointOf(feature.geometry)
      const status = String(props.status ?? 'normal') as DeviceStatus
      const style = this.deviceStyle(status)
      const entity = this.viewer.entities.add({
        id: `device:${String(props.id)}`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat, alt ?? this.groundHeight + 6),
        point: {
          pixelSize: style.pixelSize,
          color: style.color,
          outlineColor: Cesium.Color.fromCssColorString('#03121C').withAlpha(0.9),
          outlineWidth: px(1),
          // 远景必须真的变小(0.35 而不是 0.9), 且夹紧点放在相机最远距离之外,
          // 否则缩放时点位不跟着缩, 到夹紧点还会「卡」一下
          scaleByDistance: new Cesium.NearFarScalar(150, 1.6, 3500, 0.35),
          // 用有限的超大值代替 POSITIVE_INFINITY: 语义一样(永远画在体块前面),
          // 但避免部分 WebGL 实现对 z=0 的处理差异导致图元被丢弃
          disableDepthTestDistance: 2_000_000,
        },
      })
      group.entities.push(entity)
      this.devicePoints.set(String(props.id), entity)
      this.deviceMeta.set(String(props.id), {
        type: String(props.type ?? 'hvac'),
        status,
        floor: Number(props.floor ?? 0),
        buildingId: props.building_id ? String(props.building_id) : null,
      })
    }
    // 切 LOD 会重建点位, 已选中的高模要跟着换到新坐标上
    if (this.modelDevice) this.showDeviceModel(this.modelDevice)
  }

  // ---------------------------------------------------------------- 设备高模 (Three.js)
  get hasModelLayer(): boolean {
    return this.modelLayer !== null
  }

  get hasDeviceModel(): boolean {
    return this.modelDevice !== null
  }

  /**
   * 挂载/卸载设备高模。
   * 高度规则: 室外设备(floor=0)贴地坪摆放, 室内设备落在点位所在楼层高度,
   * 否则室外机组会悬在离地 3m 的半空。
   */
  /**
   * 高模的落位锚点。室外设备(floor=0)贴地坪摆放, 室内设备落在点位所在楼层,
   * 否则室外机组会悬在离地 3m 的半空。
   */
  private deviceAnchor(
    id: string,
  ): { lon: number; lat: number; alt: number; meta: DeviceMeta } | null {
    const meta = this.deviceMeta.get(id)
    const position = this.devicePoints.get(id)?.position?.getValue(Cesium.JulianDate.now())
    if (!meta || !position) return null
    const carto = Cesium.Cartographic.fromCartesian(position)
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      alt: meta.floor > 0 ? carto.height : this.groundHeight,
      meta,
    }
  }

  showDeviceModel(id: string | null): void {
    this.modelDevice = id
    const layer = this.modelLayer
    const anchor = id ? this.deviceAnchor(id) : null
    // 室内设备被所在楼栋整个包住, 视距拉到 50m 时相机其实在体块内部,
    // 整屏都是楼栋色; 这里把宿主楼栋临时「透视」掉, 只留轮廓与标签做方位参考
    this.setGhostBuilding(anchor ? anchor.meta.buildingId : null)
    if (!layer) return
    if (!id || !anchor) {
      this.modelStatus = null
      layer.setDevice(null)
      return
    }
    this.modelStatus = anchor.meta.status
    layer.setDevice({
      id,
      type: anchor.meta.type,
      status: anchor.meta.status,
      lon: anchor.lon,
      lat: anchor.lat,
      altitude: anchor.alt,
      floor: anchor.meta.floor,
    })
  }

  private setGhostBuilding(id: string | null): void {
    if (this.ghostBuilding === id) return
    const previous = this.ghostBuilding
    this.ghostBuilding = id
    if (previous) this.paintBuilding(previous)
    if (id) this.paintBuilding(id)
    this.syncShell()
  }

  /**
   * 外壳可见性。
   * 矢量模式下「透视」靠体块 alpha; 模型模式的外壳是整块 3D Tiles, 逐栋透明度不可控
   * (每栋一个 glb tile, Cesium 不暴露按 tile 隐藏的公共接口), 所以看室内设备时整层让路。
   * 反正此刻相机就在该楼内部, 外壳只会糊住视口。
   */
  private syncShell(): void {
    if (this.tileset) this.tileset.show = this.shellMode === 'model' && this.ghostBuilding === null
  }

  /**
   * 选中设备时贴近观察: 高模只有 2~3m, 800m 视距下不足一个像素。
   *
   * 相机位置不能直接用 flyToBoundingSphere 的定距环绕: 园区楼栋间距只有 20~30m,
   * 定距落点经常正好在隔壁楼体块内部, 整个视口糊成一块楼栋色。
   * 这里按「水平退距 + 俯角」反算落点, 撞上别的楼就把机位抬到它屋顶之上。
   */
  focusDevice(id: string): void {
    const anchor = this.deviceAnchor(id)
    if (!anchor) return
    const view = DEVICE_VIEW[anchor.meta.type] ?? { dist: 22, lift: 0.8 }
    // 取模型腰部而不是原点: 原点在接地面上, 直接对准会让模型整体沉到画面下方
    const targetAlt = anchor.alt + view.lift
    const latRad = Cesium.Math.toRadians(anchor.lat)

    const heading = Cesium.Math.toRadians(24)
    const horizontal = view.dist
    const camLon = anchor.lon - (horizontal * Math.sin(heading)) / (111_320 * Math.cos(latRad))
    const camLat = anchor.lat - (horizontal * Math.cos(heading)) / 111_320

    let camAlt = targetAlt + horizontal * Math.tan(Cesium.Math.toRadians(38))
    const host = anchor.meta.buildingId
    const blocker = this.buildingAt(camLon, camLat)
    if (blocker && blocker !== host) {
      camAlt = Math.max(
        camAlt,
        this.groundHeight + (this.buildingMeta.get(blocker)?.height ?? 0) + 8,
      )
    }

    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(camLon, camLat, camAlt),
      orientation: {
        heading,
        pitch: -Math.atan2(camAlt - targetAlt, horizontal),
        roll: 0,
      },
      duration: 1.1,
    })
  }

  // ---------------------------------------------------------------- 实时联动
  updateDevices(items: TelemetryItem[]): void {
    for (const item of items) {
      const meta = this.deviceMeta.get(item.id)
      // 2s 一次的全量推送里绝大多数点位状态没变, 跳过可以省掉属性重新求值与重绘
      if (meta && meta.status === item.status) continue
      if (meta) meta.status = item.status
      const entity = this.devicePoints.get(item.id)
      if (!entity?.point) continue
      const style = this.deviceStyle(item.status)
      entity.point.color = style.color
      entity.point.pixelSize = style.pixelSize
    }
    // 高模指示灯跟随状态, 只在状态真变化时重建几何, 不随 2s 一次的推送重绘
    const shown = this.modelDevice ? this.deviceMeta.get(this.modelDevice) : null
    if (this.modelDevice && shown && shown.status !== this.modelStatus) {
      this.showDeviceModel(this.modelDevice)
    }
  }

  // ---------------------------------------------------------------- 选择与视角
  selectBuilding(id: string | null): void {
    const previous = this.selected
    this.selected = id
    if (previous && previous !== id) this.paintBuilding(previous)
    if (id) this.paintBuilding(id)
    else {
      this.clip = null
      this.clearSlab()
    }
    this.syncClip()
  }

  /** 体块基准高度: 略高于外壳, 保证隐形代理在拾取时稳定优先 */
  private baseZ(): number {
    return this.groundHeight + 0.3 + PICK_LIFT
  }

  private paintBuilding(id: string): void {
    const entity = this.buildingEntities.get(id)
    const meta = this.buildingMeta.get(id)
    if (!entity?.polygon || !meta) return
    const isSelected = this.selected === id
    const isHovered = this.hovered === id
    const hex = isSelected ? SELECT_HEX : meta.color

    // 模型模式: 体块退化为隐形拾取代理, 只给选中/悬停留一点罩色
    // 透视中的楼栋完全透明: 设备高模就在它的体块内部, 留一点颜色都会糊住整个视口
    const alpha =
      id === this.ghostBuilding
        ? 0
        : this.shellMode === 'model'
          ? isSelected
            ? 0.26
            : isHovered
              ? 0.1
              : 0
          : isSelected
            ? 0.92
            : isHovered
              ? 0.84
              : BASE_ALPHA

    entity.polygon.material = this.material(hex, alpha)
  }

  /**
   * 材质缓存.
   * 鼠标在楼栋间快速移动时, 每次悬停变化都 new 一个 ColorMaterialProperty 会触发
   * 反复的 definitionChanged, 画面会出现一帧闪烁 —— 复用实例即可消除。
   */
  private materialCache = new Map<string, Cesium.ColorMaterialProperty>()

  private material(hex: string, alpha: number): Cesium.ColorMaterialProperty {
    const key = `${hex}|${alpha.toFixed(2)}`
    let material = this.materialCache.get(key)
    if (!material) {
      material = new Cesium.ColorMaterialProperty(
        Cesium.Color.fromCssColorString(hex).withAlpha(alpha),
      )
      this.materialCache.set(key, material)
    }
    return material
  }

  focusBuilding(id: string): void {
    const ring = this.buildingRings.get(id)
    const meta = this.buildingMeta.get(id)
    if (!ring || !meta) return
    const points = Cesium.Cartesian3.fromDegreesArray(ring.flatMap(([lon, lat]) => [lon, lat]))
    const sphere = Cesium.BoundingSphere.fromPoints(points)
    this.viewer.camera.flyToBoundingSphere(sphere, {
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(28),
        Cesium.Math.toRadians(-34),
        Math.max(sphere.radius * 5.0, 190 + meta.height * 1.6),
      ),
      duration: 1.2,
    })
  }

  /**
   * 楼层剖切.
   * 矢量模式: 改 extrude 高度即可;
   * 模型模式: 用 4 个竖直裁剪面 + 1 个水平裁剪面把这栋楼「切」到第 N 层,
   *          不影响其他楼, 也不需要重新切片.
   */
  setFloorClip(id: string, floor: number): void {
    const entity = this.buildingEntities.get(id)
    const meta = this.buildingMeta.get(id)
    const ring = this.buildingRings.get(id)
    if (!entity?.polygon || !meta || !ring) return

    const base = this.baseZ()
    const clipped = Math.max(1, Math.min(floor, meta.floors))
    const top = base + meta.floorHeight * clipped
    this.clip = { id, floor: clipped }
    entity.polygon.extrudedHeight = new Cesium.ConstantProperty(top)
    this.syncClip()

    this.clearSlab()
    this.slab = this.viewer.entities.add({
      id: 'slab:active',
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(
          Cesium.Cartesian3.fromDegreesArrayHeights(flatten(ring, top + 0.06)),
        ),
        material: Cesium.Color.fromCssColorString(SELECT_HEX).withAlpha(0.85),
      },
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(flatten(ring, top + 0.1)),
        width: px(2),
        arcType: Cesium.ArcType.NONE,
        material: Cesium.Color.fromCssColorString(SELECT_HEX),
      },
    })
  }

  resetFloorClip(id: string): void {
    this.clip = null
    const entity = this.buildingEntities.get(id)
    const meta = this.buildingMeta.get(id)
    if (!entity?.polygon || !meta) return
    entity.polygon.extrudedHeight = new Cesium.ConstantProperty(this.baseZ() + meta.height)
    this.clearSlab()
    this.syncClip()
  }

  private clearSlab(): void {
    if (this.slab) {
      this.viewer.entities.remove(this.slab)
      this.slab = null
    }
  }

  // ---------------------------------------------------------------- 三维外壳 (3D Tiles)
  get hasShell(): boolean {
    return this.tileset !== null
  }

  /**
   * 加载三维外壳瓦片.
   * 任何 3D Tiles 1.0/1.1 tileset 都能挂: 演示用的是矢量体块挤出的替身,
   * 真实项目换成倾斜摄影切片后, 这里一行都不用改.
   */
  async loadShell(
    url: string,
    onProgress?: (percent: number, done: boolean) => void,
  ): Promise<boolean> {
    try {
      // 重复调用时先释放上一份, 避免两套瓦片与裁剪面并存
      this.disposeShell()
      const tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
        maximumScreenSpaceError: 16,
        // 动态误差会随相机移动反复调整瓦片取舍, 表现为几何体「游动/跳动」, 园区级固定视角不需要
        dynamicScreenSpaceError: false,
      })
      this.tileset = tileset
      this.viewer.scene.primitives.add(tileset)
      this.syncShell()

      // 裁剪面集合必须常驻: Cesium3DTileset.clippingPlanes 不接受 undefined
      this.clipCollection = new Cesium.ClippingPlaneCollection({
        planes: [],
        unionClippingRegions: false,
        enabled: false,
        edgeColor: Cesium.Color.fromCssColorString(SELECT_HEX).withAlpha(0.6),
        edgeWidth: 1.0,
      })
      tileset.clippingPlanes = this.clipCollection

      const report = () => {
        const { total, ready } = countTiles(tileset.root as TileNode)
        onProgress?.(Math.round((ready / Math.max(total, 1)) * 100), ready >= total)
      }
      // 解绑函数要留着: 监听器持有闭包, 不摘会在瓦片销毁后继续被事件回调
      this.removeTilesetListeners.push(
        tileset.loadProgress.addEventListener(report),
        tileset.allTilesLoaded.addEventListener(report),
      )
      report()

      this.syncClip()
      return true
    } catch (err) {
      console.warn('[twin] 三维瓦片加载失败, 回退矢量体块', err)
      return false
    }
  }

  /** 释放瓦片与裁剪面集合: 监听器、GPU 资源、集合都要显式回收 */
  private disposeShell(): void {
    for (const remove of this.removeTilesetListeners) remove()
    this.removeTilesetListeners = []
    if (this.tileset) {
      this.viewer.scene.primitives.remove(this.tileset)
      if (!this.tileset.isDestroyed()) this.tileset.destroy()
      this.tileset = null
    }
    if (this.clipCollection) {
      this.clipCollection.enabled = false
      if (!this.clipCollection.isDestroyed()) this.clipCollection.destroy()
      this.clipCollection = null
    }
  }

  /** 建筑表现: model 用三维外壳 + 隐形拾取代理, vector 回到矢量体块 */
  setShellMode(mode: 'vector' | 'model'): void {
    if (mode === this.shellMode) return
    this.shellMode = mode
    this.syncShell()
    for (const id of this.buildingEntities.keys()) this.paintBuilding(id)
    this.syncClip()
  }

  private syncClip(): void {
    const collection = this.clipCollection
    if (!collection) return
    collection.removeAll()
    const planes =
      this.shellMode === 'model' && this.clip
        ? this.buildClipPlanes(this.clip.id, this.clip.floor)
        : null
    if (planes) for (const plane of planes) collection.add(plane)
    collection.enabled = Boolean(planes)
  }

  /**
   * 用 5 个裁剪面围出「这栋楼 + 第 N 层以下」的盒子.
   * 这样只切一栋楼, 不需要为剖切重新切片; 真倾斜摄影瓦片同样适用.
   * Cesium 保留 dot(normal, p) + distance >= 0 的一侧, 所以法线都指向盒子内侧.
   */
  private buildClipPlanes(id: string, floor: number): Cesium.ClippingPlane[] | null {
    const ring = this.buildingRings.get(id)
    const meta = this.buildingMeta.get(id)
    if (!ring || !meta || ring.length < 3) return null

    const cLon = ring.reduce((sum, p) => sum + p[0], 0) / ring.length
    const cLat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length
    const origin = Cesium.Cartesian3.fromDegrees(cLon, cLat, this.groundHeight)
    const rotation = Cesium.Matrix4.getMatrix3(
      Cesium.Transforms.eastNorthUpToFixedFrame(origin),
      new Cesium.Matrix3(),
    )
    const toWorld = (dir: Cesium.Cartesian3) =>
      Cesium.Matrix3.multiplyByVector(rotation, dir, new Cesium.Cartesian3())

    const lonScale = 111_320 * Math.cos(Cesium.Math.toRadians(cLat))
    let hx = 2
    let hy = 2
    for (const [lon, lat] of ring) {
      hx = Math.max(hx, Math.abs((lon - cLon) * lonScale))
      hy = Math.max(hy, Math.abs((lat - cLat) * 111_320))
    }
    hx += 2
    hy += 2
    const top = meta.floorHeight * Math.max(1, Math.min(floor, meta.floors)) + 0.3

    const plane = (dirLocal: Cesium.Cartesian3, distanceLocal: number) => {
      const normal = toWorld(dirLocal)
      return new Cesium.ClippingPlane(normal, distanceLocal - Cesium.Cartesian3.dot(normal, origin))
    }
    const east = new Cesium.Cartesian3(1, 0, 0)
    const north = new Cesium.Cartesian3(0, 1, 0)
    const up = new Cesium.Cartesian3(0, 0, 1)
    const negate = (value: Cesium.Cartesian3) =>
      Cesium.Cartesian3.negate(value, new Cesium.Cartesian3())

    return [
      plane(negate(east), hx),
      plane(east, hx),
      plane(negate(north), hy),
      plane(north, hy),
      plane(negate(up), top),
    ]
  }

  /** 世界坐标落在哪栋楼: 供三维外壳(无逐要素属性)时反查 */
  private buildingAt(lon: number, lat: number): string | null {
    for (const [id, ring] of this.buildingRings) {
      if (ring.length < 3) continue
      let inside = false
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
          inside = !inside
        }
      }
      if (inside) return id
    }
    return null
  }

  setHome(park: Park): void {
    this.homeCenter = park.center
    this.homeHeading = park.camera.heading
    this.homePitch = park.camera.pitch
    const [minLon, minLat, maxLon, maxLat] = park.bbox
    const width = (maxLon - minLon) * 111_320 * Math.cos(Cesium.Math.toRadians(park.center[1]))
    const depth = (maxLat - minLat) * 111_320
    // 观察距离按园区实际跨度反推, 保证整园入画; 数据里的 camera.height 只作为下限
    this.homeHeight = Math.max(park.camera.height, Math.max(width, depth) * 1.55)

    // 2D 视图用外扩 12% 的矩形框住园区, 保证切换后整园入画
    const padX = (maxLon - minLon) * 0.12
    const padY = (maxLat - minLat) * 0.12
    this.parkRect = Cesium.Rectangle.fromDegrees(
      minLon - padX,
      minLat - padY,
      maxLon + padX,
      maxLat + padY,
    )
  }

  /**
   * 相机以「目标点 + 距离 + 俯角」定义, 而不是直接给高度。
   * 只给高度会让相机悬在园区正上方朝前看, 园区反而落在视野外。
   */
  private applyHome(instant: boolean): void {
    const pitch = Cesium.Math.toRadians(this.homePitch)
    const heading = Cesium.Math.toRadians(this.homeHeading)
    const range = this.homeHeight
    const target = Cesium.Cartesian3.fromDegrees(
      this.homeCenter[0],
      this.homeCenter[1],
      this.groundHeight,
    )
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(target)
    const offset = new Cesium.Cartesian3(
      -range * Math.cos(pitch) * Math.sin(heading),
      -range * Math.cos(pitch) * Math.cos(heading),
      -range * Math.sin(pitch),
    )
    const destination = Cesium.Matrix4.multiplyByPoint(enu, offset, new Cesium.Cartesian3())
    const orientation = { heading, pitch, roll: 0 }

    if (instant) {
      // 首帧必须就位: flyTo 在首帧动画未推进时会把相机停在默认全球视角
      this.viewer.camera.setView({ destination, orientation })
      return
    }
    this.viewer.camera.flyTo({ destination, orientation, duration: 1.5 })
  }

  flyHome(): void {
    this.applyHome(false)
  }

  /**
   * 视图模式切换。
   * 2D 是正交投影, 相机沿用 3D 的斜视角会落到错误位置导致「看不见园区」,
   * 因此等 morph 完成后按园区矩形重新定位; 回到 3D 则回到默认斜俯视。
   */
  /**
   * 视图模式切换。
   *
   * 用 duration=0 的瞬时切换, 不用 Cesium 的异步过渡:
   *  - 异步 morph 依赖连续帧推进, 在低帧率/后台标签页下会卡在 MORPHING,
   *    相机停在半路, 表现就是「一切平面就看不见园区」;
   *  - 过渡的观感交给 UI 层的 loading 遮罩, 稳定且可控。
   */
  morph(mode: '3d' | '2d'): void {
    const target = mode === '2d' ? Cesium.SceneMode.SCENE2D : Cesium.SceneMode.SCENE3D
    // 已在目标模式时不能重复调 morphToX
    if (this.viewer.scene.mode === target) return

    try {
      if (mode === '2d') {
        this.viewer.scene.morphTo2D(0)
        // 2D 必须重新框定视角, 否则相机停在 3D 的斜视角投影位置
        if (this.parkRect) this.viewer.camera.setView({ destination: this.parkRect })
      } else {
        this.viewer.scene.morphTo3D(0)
        this.applyHome(true)
      }
    } catch (err) {
      console.warn('[twin] 视图切换失败', err)
      // 兜底: 至少保证不卡在中转态
      if (this.viewer.scene.mode === Cesium.SceneMode.MORPHING) {
        this.viewer.scene.completeMorph()
      }
    }
    // 滚轮的归属按模式切换: 2D 用 Cesium 的框选缩放, 3D 用下面自己的固定比例推拉
    this.syncZoomEvents()
  }

  // ---------------------------------------------------------------- 滚轮缩放
  /**
   * 三维视图的滚轮缩放改为「沿视线按固定比例推拉」.
   *
   * Cesium 默认的 3D 缩放内部有两套运镜, 运行时按相机俯角与光标下的命中结果二选一:
   *   - |dot(direction, 地表法线)| ≈ 0.6 (俯角约 ±37°) 时切成沿视线推进, 否则绕枢轴环绕;
   *   - 枢轴位置来自 pickPosition, 相机进到楼里后同一屏幕点可能命中外墙、楼板、
   *     设备点, 也可能什么都命中不到, 每次滚轮重新拾取一次.
   * 于是近景连续滚轮会在「环绕」和「推进」之间来回切换, 步长还随命中距离大幅变化,
   * 表现就是一段一段地跳 —— 而 focusDevice 的机位俯角正好落在 38°, 贴着切换阈值.
   *
   * 这里统一成: 每格滚轮沿视线推拉「当前视距的 12%」. 视距只用相机高度与俯角推算,
   * 不做拾取, 因此连续、可预期, 与光标下方是什么无关; 俯仰/旋转仍交给 Cesium.
   */
  private bindZoom(): void {
    this.syncZoomEvents()
    this.viewer.scene.canvas.addEventListener('wheel', this.onWheel, { passive: false })
  }

  /** 三维只手势捏合交给 Cesium, 滚轮自己处理; 平面视图保持 Cesium 的滚轮框选 */
  private syncZoomEvents(): void {
    const controller = this.viewer.scene.screenSpaceCameraController
    controller.zoomEventTypes =
      this.viewer.scene.mode === Cesium.SceneMode.SCENE3D
        ? [Cesium.CameraEventType.PINCH]
        : [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH]
  }

  private onWheel = (event: WheelEvent): void => {
    // 平面视图保留 Cesium 的框选缩放, 不拦事件
    if (this.viewer.scene.mode !== Cesium.SceneMode.SCENE3D) return
    event.preventDefault()

    // 归一化滚动量: 行/页模式换算成像素, 再按 100px 一格; 触控板的小增量会得到细粒度步长
    const unit =
      event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewer.scene.canvas.clientHeight : 1
    const notches = (-event.deltaY * unit) / 100 // 正 = 向前(放大)
    if (!notches) return

    const camera = this.viewer.camera
    // 滚轮要能打断正在进行的飞行动画, 否则缩放手感像"卡住一下再跳"
    camera.cancelFlight()
    const step = this.viewDistance() * (1 - Math.pow(1 + WHEEL_ZOOM_STEP, -notches))
    const clamped = this.clampZoomStep(step, camera)
    if (clamped) camera.move(camera.direction, clamped)
  }

  /** 视距估计: 只用相机高度与俯角, 不做拾取 (拾取结果在楼里会跳) */
  private viewDistance(): number {
    const camera = this.viewer.camera
    const height = Math.max(camera.positionCartographic.height, 1)
    // 俯角越平, 同样高度对应的视距越远; 夹一个下限, 避免平视时步长被放大到不可控
    const sinPitch = Math.max(Math.abs(Math.sin(camera.pitch)), 0.35)
    return Math.min(height / sinPitch, MAX_ZOOM_HEIGHT)
  }

  /** 推拉时不许扎进地面, 也不许退到最大视距之外 */
  private clampZoomStep(step: number, camera: Cesium.Camera): number {
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(camera.positionWC, this.scratchUp)
    // direction 每前进 1m 带来的高度变化: 负值表示朝下看
    const vertical = Cesium.Cartesian3.dot(camera.direction, up)
    if (Math.abs(vertical) < 1e-6) return step

    const height = camera.positionCartographic.height
    const target = height + step * vertical
    let clamped = step
    if (target < MIN_ZOOM_HEIGHT) clamped = (MIN_ZOOM_HEIGHT - height) / vertical
    else if (target > MAX_ZOOM_HEIGHT) clamped = (MAX_ZOOM_HEIGHT - height) / vertical
    // 夹紧后方向反了, 说明已经贴到边界, 这一步直接吃掉
    return clamped * step < 0 ? 0 : clamped
  }

  // ---------------------------------------------------------------- 图层可见性
  setLayerVisible(key: string, visible: boolean): void {
    const group = this.groups.get(key)
    if (!group) return
    group.visible = visible
    this.applyVisibility(key, visible)
  }

  private applyVisibility(key: string, visible: boolean): void {
    const group = this.groups.get(key)
    if (!group) return
    for (const entity of group.entities) entity.show = visible
    for (const collection of group.collections) collection.show = visible
  }

  // ---------------------------------------------------------------- 交互
  private bindInput(): void {
    this.handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = this.viewer.scene.pick(movement.position)
      if (!Cesium.defined(picked)) {
        this.callbacks.onBlank()
        return
      }
      const pickedId = picked.id
      if (pickedId instanceof Cesium.Entity) {
        const raw = String(pickedId.id)
        if (raw.startsWith('building:')) {
          this.callbacks.onPickBuilding(raw.slice(9))
          return
        }
        if (raw.startsWith('device:')) {
          this.callbacks.onPickDevice(raw.slice(7))
          return
        }
      }

      // 命中三维外壳, 或体块图层被关掉时: 用拾取点反查所属楼栋
      try {
        const hit = this.viewer.scene.pickPosition(movement.position)
        if (Cesium.defined(hit)) {
          const carto = Cesium.Cartographic.fromCartesian(hit)
          const id = this.buildingAt(
            Cesium.Math.toDegrees(carto.longitude),
            Cesium.Math.toDegrees(carto.latitude),
          )
          if (id) {
            this.callbacks.onPickBuilding(id)
            return
          }
        }
      } catch {
        /* pickPosition 在个别显卡上不可用, 忽略 */
      }
      this.callbacks.onBlank()
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    this.handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      // 鼠标移动事件频率远高于帧率, 且这里要做 3 次拾取(实体/坐标/经纬度).
      // 按帧合并: 一帧最多拾取一次, 指针位置只保留最后一次.
      this.pendingHover = { x: movement.endPosition.x, y: movement.endPosition.y }
      if (this.hoverFrame) return
      this.hoverFrame = requestAnimationFrame(() => {
        this.hoverFrame = 0
        const position = this.pendingHover
        this.pendingHover = null
        if (position) this.handleHover(position.x, position.y)
      })
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
  }

  /** 悬停拾取: 楼栋高亮 + 浮标 + 状态栏经纬度 */
  private handleHover(x: number, y: number): void {
    const screen = this.scratchScreen
    screen.x = x
    screen.y = y

    const picked = this.viewer.scene.pick(screen)
    let nextHover: string | null = null
    if (Cesium.defined(picked) && picked.id instanceof Cesium.Entity) {
      const raw = String(picked.id.id)
      if (raw.startsWith('building:')) nextHover = raw.slice(9)
    }

    if (nextHover !== this.hovered) {
      const previous = this.hovered
      this.hovered = nextHover
      if (previous) this.paintBuilding(previous)
      if (nextHover) this.paintBuilding(nextHover)
      this.viewer.scene.canvas.style.cursor = nextHover ? 'pointer' : 'default'
    }

    if (nextHover) {
      const meta = this.buildingMeta.get(nextHover)
      if (meta) {
        this.callbacks.onHover({
          x,
          y,
          title: meta.name,
          sub: `${meta.floors}F · ${meta.height}m · ${meta.floorHeight.toFixed(2)}m/层`,
        })
      }
    } else if (this.hovered === null) {
      this.callbacks.onHover(null)
    }

    const ray = this.viewer.camera.getPickRay(screen)
    const position = ray ? this.viewer.scene.globe.pick(ray, this.viewer.scene) : undefined
    if (position) {
      const carto = Cesium.Cartographic.fromCartesian(position)
      this.callbacks.onCursor({
        lon: Cesium.Math.toDegrees(carto.longitude),
        lat: Cesium.Math.toDegrees(carto.latitude),
      })
    } else {
      this.callbacks.onCursor(null)
    }
  }

  /** 运维诊断: 要素数量与相机状态 (2D 下 positionCartographic 为 undefined, 需分别处理) */
  debugInfo(): Record<string, unknown> {
    const info: Record<string, unknown> = {
      buildings: this.buildingEntities.size,
      rings: this.buildingRings.size,
      devicePoints: this.devicePoints.size,
      entities: this.viewer.entities.values.length,
      primitives: this.viewer.scene.primitives.length,
      mode: this.viewer.scene.mode,
      shell: this.tileset ? { mode: this.shellMode, clip: this.clip } : null,
      groups: Object.fromEntries(
        Array.from(this.groups.entries()).map(([key, group]) => [
          key,
          { e: group.entities.length, c: group.collections.length, v: group.visible },
        ]),
      ),
    }

    try {
      const carto = this.viewer.camera.positionCartographic
      if (carto) {
        info.camHeight = Math.round(carto.height)
        info.camLon = Cesium.Math.toDegrees(carto.longitude).toFixed(4)
        info.camLat = Cesium.Math.toDegrees(carto.latitude).toFixed(4)
        info.pitch = Cesium.Math.toDegrees(this.viewer.camera.pitch).toFixed(1)
      } else {
        const p = this.viewer.camera.position
        info.cam2d = [Math.round(p.x), Math.round(p.y), Math.round(p.z)]
      }
      const rect = this.viewer.camera.computeViewRectangle()
      if (rect) {
        info.view = [
          Cesium.Math.toDegrees(rect.west).toFixed(3),
          Cesium.Math.toDegrees(rect.south).toFixed(3),
          Cesium.Math.toDegrees(rect.east).toFixed(3),
          Cesium.Math.toDegrees(rect.north).toFixed(3),
        ]
      }
    } catch (err) {
      info.cam = `unavailable: ${String(err)}`
    }

    return info
  }

  dispose(): void {
    if (this.hoverFrame) {
      cancelAnimationFrame(this.hoverFrame)
      this.hoverFrame = 0
    }
    this.pendingHover = null
    // postRender 回调持有 this, 不摘掉的话 viewer 虽销毁, 回调仍被 Cesium 全局事件引用
    if (this.removePostRender) {
      this.removePostRender()
      this.removePostRender = null
    }
    this.viewer.scene.canvas.removeEventListener('wheel', this.onWheel)
    this.handler.destroy()
    this.disposeShell()
    this.modelLayer?.dispose()
    this.modelLayer = null
    this.materialCache.clear()
    this.deviceStyleCache.clear()
    // 控制台调试句柄指向已销毁实例会造成"看起来还能用"的误判
    const host = window as unknown as { __twin?: TwinScene }
    if (host.__twin === this) delete host.__twin
    this.viewer.destroy()
  }
}
