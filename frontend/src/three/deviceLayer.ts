import * as Cesium from 'cesium'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { DeviceStatus } from '../types'
import { createDeviceModel, type DeviceModelHandle } from './deviceModels'

export interface DeviceModelSpec {
  id: string
  type: string
  status: DeviceStatus
  lon: number
  lat: number
  /** 安装面高程(米); 室外设备取园区地坪, 室内设备取所在楼层 */
  altitude: number
  floor: number
}

/**
 * 设备级高模图层: 一块透明的 Three.js 画布, 叠在 Cesium 画布之上。
 *
 * 为什么不写成 Cesium.Primitive:
 *   Cesium 的渲染管线不对外暴露第三个渲染通道, 把 Three.js 塞进 Primitive 只能
 *   「离屏渲染 -> 当纹理贴到屏幕四边形」, 多一次全屏拷贝, 且依然拿不到深度缓冲。
 *   叠加画布同样拿不到 Cesium 的深度, 但零拷贝、可独立抗锯齿、可随时整层隐藏。
 *
 * 位置怎么对齐:
 *   1. 取园区中心建 ENU 局部系, 模型坐标用「米」表达, 避开 ECEF 的 6.4e6 量级精度损耗;
 *   2. 每帧把 Cesium 的 view 矩阵左乘「局部系 -> ECEF」, 再把 Cesium 的投影矩阵原样
 *      交给 Three.js —— 两台相机的 eye space 都是 x右/y上/-z前, 可以直接互换矩阵。
 */
export class DeviceModelLayer {
  private readonly container: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera()
  private readonly holder = new THREE.Group()
  private readonly envTexture: THREE.Texture
  private lastFrame = 0

  /** 局部系(米, y 上) -> ECEF; threeToFixed 为其逆 */
  private readonly fixedToThree: Cesium.Matrix4
  private readonly threeToFixed: Cesium.Matrix4
  private readonly viewScratch = new Cesium.Matrix4()

  private current: DeviceModelHandle | null = null
  private enabled = true
  private shown = false
  private width = 0
  private height = 0

  constructor(container: HTMLElement, center: [number, number]) {
    this.container = container
    const origin = Cesium.Cartesian3.fromDegrees(center[0], center[1], 0)
    const fixedToEnu = Cesium.Matrix4.inverse(
      Cesium.Transforms.eastNorthUpToFixedFrame(origin),
      new Cesium.Matrix4(),
    )
    // ENU(east, north, up) -> Three.js(east, up, -north): 保持右手系, 且 y 轴向上
    const enuToYUp = Cesium.Matrix4.fromRotationTranslation(
      Cesium.Matrix3.fromRowMajorArray([1, 0, 0, 0, 0, 1, 0, -1, 0]) as Cesium.Matrix3,
      Cesium.Cartesian3.ZERO,
      new Cesium.Matrix4(),
    )
    this.fixedToThree = Cesium.Matrix4.multiply(enuToYUp, fixedToEnu, new Cesium.Matrix4())
    this.threeToFixed = Cesium.Matrix4.inverse(this.fixedToThree, new Cesium.Matrix4())

    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      // 压在 Cesium 画布之上, 但所有面板仍在更上层
      zIndex: '1',
      opacity: '0',
      transition: 'opacity 220ms ease',
    })
    container.appendChild(this.canvas)

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setClearAlpha(0)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.18

    // 无贴图的 PBR 金属会发黑, 用程序化房间环境光补齐反射
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    this.scene.environment = this.envTexture

    const hemi = new THREE.HemisphereLight(0xbfe4ff, 0x0a141c, 0.65)
    const key = new THREE.DirectionalLight(0xffffff, 2.0)
    key.position.set(-1.4, 2.6, 1.8)
    const rim = new THREE.DirectionalLight(0x35c3ff, 1.1)
    rim.position.set(1.6, 0.9, -1.6)
    this.scene.add(hemi, key, rim, this.holder)

    this.camera.matrixAutoUpdate = false
    this.camera.matrixWorldAutoUpdate = false
  }

  /** 显隐只改样式, 且不每帧写 DOM: 2D/切走时淡出, 回来时淡入 */
  private setShown(visible: boolean): void {
    if (this.shown === visible) return
    this.shown = visible
    this.canvas.style.opacity = visible ? '1' : '0'
  }

  /** 局部米制坐标 -> Three.js 世界坐标 */
  private toLocal(lon: number, lat: number, altitude: number): THREE.Vector3 {
    const local = Cesium.Matrix4.multiplyByPoint(
      this.threeToFixed,
      Cesium.Cartesian3.fromDegrees(lon, lat, altitude),
      new Cesium.Cartesian3(),
    )
    return new THREE.Vector3(local.x, local.y, local.z)
  }

  /** 挂载/卸载高模; 传 null 只隐藏, 不销毁场景 */
  setDevice(spec: DeviceModelSpec | null): void {
    if (this.current) {
      this.holder.remove(this.current.root)
      this.current.dispose()
      this.current = null
    }
    this.enabled = spec !== null
    if (!spec) {
      this.setShown(false)
      return
    }

    const handle = createDeviceModel(spec.type, spec.status)
    handle.root.position.copy(this.toLocal(spec.lon, spec.lat, spec.altitude))
    // 固定 20° 朝向: 让正脸偏一点, 避免所有设备都笔直朝南像贴图
    handle.root.rotation.y = Math.PI * 0.11
    this.holder.add(handle.root)
    this.current = handle
    this.setShown(true)
  }

  /**
   * 每帧调用: 同步相机并渲染。
   * 2D 是正交投影, 体块与高模的透视关系对不上, 直接整层隐藏。
   */
  sync(camera: Cesium.Camera, mode: Cesium.SceneMode): void {
    if (!this.enabled || mode !== Cesium.SceneMode.SCENE3D) {
      this.setShown(false)
      return
    }
    this.setShown(true)

    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (!width || !height) return
    if (width !== this.width || height !== this.height) {
      this.width = width
      this.height = height
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      this.renderer.setSize(width, height, false)
    }

    // view_three = view_cesium * (局部系 -> ECEF)
    const view = Cesium.Matrix4.multiply(camera.viewMatrix, this.fixedToThree, this.viewScratch)
    this.camera.projectionMatrix.fromArray(Cesium.Matrix4.toArray(camera.frustum.projectionMatrix))
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert()
    this.camera.matrixWorldInverse.fromArray(Cesium.Matrix4.toArray(view))
    this.camera.matrixWorld.copy(this.camera.matrixWorldInverse).invert()

    // 自己算帧间隔: three 的 Clock 已废弃, Timer 又不在类型声明里
    const now = performance.now()
    const delta = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.1) : 0
    this.lastFrame = now
    this.holder.traverse((object) => {
      const spin = object.userData.spin
      if (typeof spin === 'number') object.rotation.y += spin * delta
    })
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    if (this.current) {
      this.holder.remove(this.current.root)
      this.current.dispose()
      this.current = null
    }
    this.envTexture.dispose()
    this.renderer.dispose()
    this.canvas.remove()
  }
}
