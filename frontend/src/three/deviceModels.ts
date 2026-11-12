import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { STATUS_HEX } from '../cesium/style'
import type { DeviceStatus } from '../types'

/**
 * 设备级高模: 全部由基础几何程序化生成, 不引入任何外部模型文件。
 *
 * 取舍:
 *  - 演示数据是 200 台点位设备, 若为每台准备 glTF, 光体积就超过整个前端包;
 *    程序化几何把「高模」压缩成几十行可参数化代码, 且能按设备状态换色。
 *  - 单位统一为米, 原点在设备接地/安装面中心, y 轴向上。
 *    这样 Cesium 侧的经纬高直接映射过来, 不需要额外的缩放或旋转修正。
 */

const METAL = { color: '#3A4E62', metalness: 0.82, roughness: 0.36 }
const SHELL = { color: '#20313F', metalness: 0.5, roughness: 0.58 }
const TRIM = { color: '#5A7286', metalness: 0.9, roughness: 0.26 }
const PIPE = { color: '#2E9BFF', metalness: 0.7, roughness: 0.35 }
const HOT = { color: '#F0A63A', metalness: 0.7, roughness: 0.35 }
const RUBBER = { color: '#0C141B', metalness: 0.1, roughness: 0.92 }

type MaterialOptions = THREE.MeshStandardMaterialParameters

/** 几何/材质集中登记, 切设备时一次性释放, 避免 GPU 侧泄漏 */
class Parts {
  readonly root = new THREE.Group()
  private materials = new Map<string, THREE.Material>()
  private geometries = new Set<THREE.BufferGeometry>()

  material(key: string, options: MaterialOptions): THREE.MeshStandardMaterial {
    const cached = this.materials.get(key)
    if (cached) return cached as THREE.MeshStandardMaterial
    const material = new THREE.MeshStandardMaterial(options)
    this.materials.set(key, material)
    return material
  }

  /** 手工组装的几何也要登记, 否则切设备时这块显存不会回收 */
  track<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry)
    return geometry
  }

  trackMaterial<T extends THREE.Material>(material: T): T {
    this.materials.set(`tracked-${this.materials.size}`, material)
    return material
  }

  /** 状态色: 面板指示灯与机身描边都用它, 一眼能看出设备是否越限 */
  statusMaterial(status: DeviceStatus): THREE.MeshStandardMaterial {
    const hex = STATUS_HEX[status] ?? STATUS_HEX.normal
    return this.material(`status-${status}`, {
      color: hex,
      emissive: hex,
      emissiveIntensity: 1.6,
      metalness: 0,
      roughness: 1,
    })
  }

  add<T extends THREE.Object3D>(object: T): T {
    this.root.add(object)
    return object
  }

  mesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position?: [number, number, number],
  ): THREE.Mesh {
    this.geometries.add(geometry)
    const mesh = new THREE.Mesh(geometry, material)
    if (position) mesh.position.set(...position)
    mesh.castShadow = false
    mesh.receiveShadow = false
    return this.add(mesh)
  }

  /** 倒角箱体: 直角边在近景下会显得廉价, 统一给 2cm 圆角 */
  box(
    material: THREE.Material,
    size: [number, number, number],
    position: [number, number, number],
    radius = 0.02,
  ): THREE.Mesh {
    const geometry = new RoundedBoxGeometry(size[0], size[1], size[2], 2, radius)
    return this.mesh(geometry, material, position)
  }

  cyl(
    material: THREE.Material,
    radiusTop: number,
    radiusBottom: number,
    height: number,
    position: [number, number, number],
    segments = 24,
    openEnded = false,
  ): THREE.Mesh {
    return this.mesh(
      new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments, 1, openEnded),
      material,
      position,
    )
  }

  /** 六角螺栓头: 高模的「贵」往往体现在这类小件上 */
  bolts(material: THREE.Material, count: number, radius: number, y: number): void {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2
      this.cyl(
        material,
        0.022,
        0.022,
        0.03,
        [Math.cos(angle) * radius, y, Math.sin(angle) * radius],
        6,
      )
    }
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials.values()) material.dispose()
    this.geometries.clear()
    this.materials.clear()
    this.root.clear()
  }
}

/** 风扇叶轮: 旋转件单独成组, 交给图层按帧推进, 让高模有「在转」的生命感 */
function fanRotor(
  parts: Parts,
  radius: number,
  bladeMaterial: THREE.Material,
  hubMaterial: THREE.Material,
): THREE.Group {
  const rotor = new THREE.Group()
  const hub = new THREE.Mesh(
    parts.track(new THREE.CylinderGeometry(radius * 0.22, radius * 0.26, 0.06, 20)),
    hubMaterial,
  )
  rotor.add(hub)

  const bladeGeometry = parts.track(new THREE.BoxGeometry(radius * 0.82, 0.012, radius * 0.34))
  for (let i = 0; i < 5; i += 1) {
    const blade = new THREE.Mesh(bladeGeometry, bladeMaterial)
    blade.position.set(radius * 0.46, 0, 0)
    const arm = new THREE.Group()
    arm.rotation.y = (i / 5) * Math.PI * 2
    arm.add(blade)
    rotor.add(arm)
  }
  rotor.userData.spin = 2.4
  parts.add(rotor)
  return rotor
}

function buildChiller(parts: Parts, status: DeviceStatus): void {
  const metal = parts.material('metal', METAL)
  const shell = parts.material('shell', SHELL)
  const trim = parts.material('trim', TRIM)
  const pipe = parts.material('pipe', PIPE)
  const rubber = parts.material('rubber', RUBBER)

  parts.box(
    parts.material('base', { color: '#0E1A24', metalness: 0.5, roughness: 0.7 }),
    [3.7, 0.14, 2.0],
    [0, 0.07, 0],
    0.02,
  )
  parts.box(metal, [3.3, 1.2, 1.72], [0, 0.74, 0], 0.06)
  parts.box(shell, [3.36, 0.1, 1.78], [0, 1.39, 0], 0.03)

  // 顶部两台冷凝风机 + 护网
  for (const x of [-0.82, 0.82]) {
    parts.cyl(trim, 0.55, 0.55, 0.06, [x, 1.46, 0], 32, true)
    parts.mesh(new THREE.TorusGeometry(0.55, 0.018, 8, 40), trim, [x, 1.46, 0])
    for (const r of [0.2, 0.36]) {
      parts.mesh(new THREE.TorusGeometry(r, 0.006, 6, 36), trim, [x, 1.47, 0])
    }
    const rotor = fanRotor(parts, 0.5, trim, shell)
    rotor.position.set(x, 1.44, 0)
    rotor.rotation.x = 0
  }

  // 前脸控制柜: 屏幕 + 按键 + 铭牌
  parts.box(shell, [0.62, 0.8, 0.05], [1.02, 0.82, 0.88], 0.02)
  parts.box(
    parts.material('screen', {
      color: '#06222E',
      emissive: '#35C3FF',
      emissiveIntensity: 0.55,
      metalness: 0.1,
      roughness: 0.2,
    }),
    [0.42, 0.24, 0.01],
    [1.02, 1.02, 0.91],
    0.005,
  )
  for (let i = 0; i < 3; i += 1) {
    parts.cyl(parts.statusMaterial(status), 0.026, 0.026, 0.012, [0.84 + i * 0.09, 0.98, 0.912], 16)
  }
  for (let i = 0; i < 4; i += 1) {
    parts.cyl(trim, 0.024, 0.024, 0.014, [0.84 + i * 0.11, 0.72, 0.912], 14)
  }

  // 侧向进出水管: 直管 + 弯头 + 法兰 + 阀门手轮
  for (const z of [-0.42, 0.42]) {
    const horizontal = parts.cyl(pipe, 0.115, 0.115, 0.62, [-1.86, 0.62, z], 20)
    horizontal.rotation.z = Math.PI / 2
    parts.mesh(new THREE.TorusGeometry(0.115, 0.115 * 0.5, 10, 20, Math.PI / 2), pipe, [
      -1.86,
      0.9,
      z,
    ])
    parts.cyl(pipe, 0.115, 0.115, 0.5, [-1.86, 1.16, z], 20)
    parts.cyl(trim, 0.16, 0.16, 0.035, [-1.86, 1.4, z], 20)
    parts.bolts(trim, 6, 0.135, 1.42)
    parts.mesh(new THREE.TorusGeometry(0.13, 0.02, 8, 24), hotWheel(parts), [-1.86, 1.33, z])
  }

  // 底部检修口与螺栓
  parts.box(rubber, [1.5, 0.05, 0.02], [0, 0.24, 0.87], 0.01)
  parts.bolts(trim, 8, 1.62, 0.15)
}

/** 阀门手轮统一用暖色, 和冷媒管路的蓝色区分 */
function hotWheel(parts: Parts): THREE.MeshStandardMaterial {
  return parts.material('hot', HOT)
}

function buildPump(parts: Parts, status: DeviceStatus): void {
  const metal = parts.material('metal', METAL)
  const shell = parts.material('shell', SHELL)
  const trim = parts.material('trim', TRIM)
  const pipe = parts.material('pipe', PIPE)

  parts.box(shell, [2.0, 0.16, 0.9], [0, 0.08, 0], 0.03)

  // 卧式泵体: 蜗壳 + 进出水口
  const volute = parts.cyl(metal, 0.44, 0.44, 0.34, [-0.42, 0.6, 0], 28)
  volute.rotation.z = Math.PI / 2
  parts.mesh(new THREE.TorusGeometry(0.44, 0.05, 10, 32), trim, [-0.42, 0.6, 0])
  parts.cyl(pipe, 0.14, 0.14, 0.5, [-0.42, 1.04, 0], 20)
  const outlet = parts.cyl(pipe, 0.14, 0.14, 0.5, [-0.42, 0.6, 0.42], 20)
  outlet.rotation.x = Math.PI / 2

  // 电机 + 散热筋 + 接线盒 (筋条绕电机轴均布, 每条自身也要跟着转, 否则侧面的筋会横着插进筒里)
  parts.cyl(shell, 0.3, 0.3, 0.78, [0.32, 0.62, 0], 24).rotation.z = Math.PI / 2
  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * Math.PI * 2
    const rib = parts.box(trim, [0.72, 0.05, 0.02], [0.32, 0, 0], 0.008)
    rib.position.set(0.32, 0.62 + Math.sin(angle) * 0.3, Math.cos(angle) * 0.3)
    rib.rotation.x = -angle
  }
  parts.box(trim, [0.2, 0.14, 0.2], [0.32, 0.94, 0], 0.02)

  // 联轴器护罩
  parts.mesh(new THREE.TorusGeometry(0.18, 0.03, 8, 20), trim, [-0.02, 0.6, 0])

  // 压力表与状态灯
  parts.cyl(trim, 0.09, 0.09, 0.04, [-0.42, 1.24, 0.14], 20).rotation.x = Math.PI / 2
  parts.cyl(parts.statusMaterial(status), 0.035, 0.035, 0.02, [0.62, 0.86, 0.16], 14)
  parts.bolts(trim, 6, 0.86, 0.16)
}

function buildMeter(parts: Parts, status: DeviceStatus): void {
  const shell = parts.material('shell', SHELL)
  const trim = parts.material('trim', TRIM)

  parts.box(shell, [0.78, 1.25, 0.34], [0, 0.62, 0], 0.03)
  parts.box(trim, [0.72, 1.12, 0.02], [0, 0.62, 0.18], 0.01)
  parts.box(
    parts.material('screen', {
      color: '#05202B',
      emissive: '#35C3FF',
      emissiveIntensity: 0.7,
      metalness: 0.1,
      roughness: 0.25,
    }),
    [0.5, 0.3, 0.01],
    [0, 0.98, 0.2],
    0.005,
  )
  // 断路器排
  for (let i = 0; i < 6; i += 1) {
    parts.box(trim, [0.055, 0.13, 0.05], [-0.24 + i * 0.096, 0.62, 0.21], 0.006)
  }
  parts.cyl(parts.statusMaterial(status), 0.028, 0.028, 0.012, [0.26, 1.16, 0.2], 16)
  parts.cyl(trim, 0.026, 0.026, 0.012, [0.26, 0.98, 0.2], 14)
  parts.bolts(trim, 4, 0.31, 0.06)
}

function buildElevator(parts: Parts, status: DeviceStatus): void {
  const metal = parts.material('metal', METAL)
  const shell = parts.material('shell', SHELL)
  const trim = parts.material('trim', TRIM)

  parts.box(shell, [3.0, 0.2, 1.7], [0, 0.1, 0], 0.03)
  // 曳引轮 + 绳槽
  const sheave = parts.cyl(metal, 0.52, 0.52, 0.3, [-0.5, 0.92, 0], 32)
  sheave.rotation.z = Math.PI / 2
  for (let i = 0; i < 6; i += 1) {
    parts.mesh(new THREE.CylinderGeometry(0.53, 0.53, 0.03, 32), trim, [-0.62 + i * 0.048, 0.92, 0])
  }
  // 电机与制动器
  parts.cyl(shell, 0.34, 0.34, 0.66, [0.42, 0.92, 0], 24).rotation.z = Math.PI / 2
  parts.box(trim, [0.3, 0.34, 0.5], [0.42, 1.26, 0], 0.02)
  // 钢丝绳
  for (let i = 0; i < 4; i += 1) {
    parts.cyl(trim, 0.012, 0.012, 1.5, [-0.5, 0.3, -0.3 + i * 0.2], 8)
  }
  parts.cyl(parts.statusMaterial(status), 0.03, 0.03, 0.02, [0.42, 1.46, 0.16], 14)
  parts.bolts(trim, 8, 1.28, 0.16)
}

function buildCharge(parts: Parts, status: DeviceStatus): void {
  const shell = parts.material('shell', SHELL)
  const trim = parts.material('trim', TRIM)
  const rubber = parts.material('rubber', RUBBER)

  parts.box(shell, [0.46, 1.45, 0.3], [0, 0.72, 0], 0.05)
  parts.box(
    parts.material('screen', {
      color: '#04202A',
      emissive: '#35C3FF',
      emissiveIntensity: 0.8,
      metalness: 0.1,
      roughness: 0.2,
    }),
    [0.34, 0.4, 0.01],
    [0, 1.0, 0.16],
    0.005,
  )
  parts.cyl(parts.statusMaterial(status), 0.045, 0.045, 0.02, [0, 1.36, 0.16], 16)
  parts.cyl(trim, 0.05, 0.05, 0.05, [0, 1.42, 0.16], 16)
  // 充电枪座 + 线缆
  parts.box(trim, [0.14, 0.2, 0.12], [0, 0.52, 0.18], 0.02)
  const cable = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.0, 0.5, 0.2),
    new THREE.Vector3(0.3, 0.34, 0.34),
    new THREE.Vector3(0.34, 0.12, 0.2),
    new THREE.Vector3(0.2, 0.04, 0.0),
  ])
  parts.mesh(new THREE.TubeGeometry(cable, 24, 0.032, 8, false), rubber)
  parts.box(rubber, [0.7, 0.06, 0.7], [0, 0.03, 0], 0.02)
}

function buildCamera(parts: Parts, status: DeviceStatus): void {
  const trim = parts.material('trim', TRIM)
  const shell = parts.material('shell', SHELL)
  const metal = parts.material('metal', METAL)
  // 立杆 3.2m: 演示数据把室外点位放在离地 3m, 杆顶与点位对齐才不会"人和点各站一处"
  const mast = 3.2

  parts.cyl(metal, 0.19, 0.22, 0.06, [0, 0.03, 0], 20)
  parts.cyl(trim, 0.058, 0.075, mast, [0, mast / 2, 0], 16)
  parts.box(shell, [0.22, 0.18, 0.22], [0, mast + 0.09, 0], 0.03)
  // 云台 + 球罩 + 镜头
  parts.mesh(new THREE.SphereGeometry(0.15, 24, 16), trim, [0, mast + 0.2, 0])
  const lens = parts.cyl(trim, 0.065, 0.08, 0.13, [0, mast + 0.18, 0.15], 20)
  lens.rotation.x = Math.PI / 2
  parts.cyl(
    parts.material('glass', { color: '#041018', metalness: 0.2, roughness: 0.05 }),
    0.052,
    0.052,
    0.01,
    [0, mast + 0.18, 0.225],
    20,
  ).rotation.x = Math.PI / 2
  parts.cyl(parts.statusMaterial(status), 0.02, 0.02, 0.01, [0.08, mast + 0.28, 0.11], 12)
  parts.bolts(trim, 4, 0.15, 0.07)
}

function buildEnv(parts: Parts, status: DeviceStatus): void {
  const trim = parts.material('trim', TRIM)
  const metal = parts.material('metal', METAL)

  parts.cyl(trim, 0.035, 0.05, 1.1, [0, 0.55, 0], 12)
  // 百叶防辐射罩: 叠环, 比一整块圆柱更透气也更像真机
  for (let i = 0; i < 6; i += 1) {
    parts.cyl(metal, 0.13 - i * 0.004, 0.13 - i * 0.004, 0.028, [0, 1.14 + i * 0.052, 0], 24)
  }
  // 风速仪
  parts.cyl(trim, 0.012, 0.012, 0.16, [0, 1.46, 0], 8)
  const cupGeometry = parts.track(
    new THREE.SphereGeometry(0.045, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
  )
  for (let i = 0; i < 3; i += 1) {
    const arm = new THREE.Group()
    const cup = new THREE.Mesh(cupGeometry, metal)
    cup.position.x = 0.11
    arm.add(cup)
    arm.rotation.y = (i / 3) * Math.PI * 2
    arm.position.y = 1.54
    arm.userData.spin = 3.2
    parts.add(arm)
  }
  parts.cyl(parts.statusMaterial(status), 0.02, 0.02, 0.012, [0.09, 1.02, 0], 12)
}

function buildFire(parts: Parts, status: DeviceStatus): void {
  const trim = parts.material('trim', TRIM)
  const metal = parts.material('metal', METAL)

  parts.cyl(metal, 0.13, 0.14, 0.04, [0, 0.02, 0], 28)
  parts.cyl(trim, 0.11, 0.11, 0.035, [0, 0.055, 0], 28)
  for (let i = 0; i < 5; i += 1) {
    parts.mesh(new THREE.TorusGeometry(0.1 - i * 0.016, 0.004, 6, 28), trim, [0, 0.055, 0])
  }
  parts.cyl(parts.statusMaterial(status), 0.018, 0.018, 0.01, [0.05, 0.075, 0.05], 12)
}

function buildLight(parts: Parts, status: DeviceStatus): void {
  const trim = parts.material('trim', TRIM)
  const metal = parts.material('metal', METAL)
  const mast = 3.8

  parts.cyl(metal, 0.16, 0.19, 0.06, [0, 0.03, 0], 18)
  parts.cyl(trim, 0.05, 0.07, mast, [0, mast / 2, 0], 14)
  parts.box(metal, [0.52, 0.1, 0.24], [0.22, mast + 0.02, 0], 0.03)
  parts.box(
    parts.material('lamp', {
      color: '#0B2634',
      emissive: '#35C3FF',
      emissiveIntensity: 1.1,
      metalness: 0.1,
      roughness: 0.3,
    }),
    [0.46, 0.03, 0.2],
    [0.22, mast - 0.04, 0],
    0.01,
  )
  parts.cyl(parts.statusMaterial(status), 0.02, 0.02, 0.012, [0.44, mast + 0.04, 0.1], 12)
}

function buildParking(parts: Parts, status: DeviceStatus): void {
  const trim = parts.material('trim', TRIM)
  const metal = parts.material('metal', METAL)

  parts.cyl(metal, 0.11, 0.12, 0.035, [0, 0.02, 0], 24)
  parts.mesh(new THREE.TorusGeometry(0.105, 0.008, 8, 28), trim, [0, 0.038, 0])
  parts.cyl(parts.statusMaterial(status), 0.03, 0.03, 0.012, [0, 0.045, 0], 14)
}

const BUILDERS: Record<string, (parts: Parts, status: DeviceStatus) => void> = {
  hvac: buildChiller,
  water: buildPump,
  meter: buildMeter,
  elevator: buildElevator,
  charge: buildCharge,
  camera: buildCamera,
  env: buildEnv,
  fire: buildFire,
  light: buildLight,
  parking: buildParking,
}

export interface DeviceModelHandle {
  root: THREE.Group
  dispose: () => void
}

/**
 * 设备落地光环保留一张画布贴图即可: 中心压暗做出接地感, 外圈一道青色细环,
 * 让高模在深色底图上"站"得住, 不至于看成一个悬空的黑盒子。
 */
let decalCache: THREE.CanvasTexture | null = null

/** 光环直径(米)按设备体量给: 机房机组要罩住 3.7m 的底座, 地磁车位只要一点 */
const DECAL_SIZE: Record<string, number> = {
  hvac: 5.4,
  water: 3.8,
  elevator: 4.4,
  meter: 2.4,
  charge: 2.2,
  camera: 2.0,
  env: 1.8,
  light: 1.6,
  fire: 1.2,
  parking: 1.0,
}

function decalTexture(): THREE.CanvasTexture {
  if (decalCache) return decalCache
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const c = size / 2
    const shadow = ctx.createRadialGradient(c, c, size * 0.04, c, c, size * 0.34)
    shadow.addColorStop(0, 'rgba(0,0,0,0.55)')
    shadow.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = shadow
    ctx.fillRect(0, 0, size, size)

    const glow = ctx.createRadialGradient(c, c, size * 0.3, c, c, size * 0.5)
    glow.addColorStop(0, 'rgba(53,195,255,0.22)')
    glow.addColorStop(1, 'rgba(53,195,255,0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, size, size)

    ctx.strokeStyle = 'rgba(53,195,255,0.55)'
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.arc(c, c, size * 0.38, 0, Math.PI * 2)
    ctx.stroke()
  }
  decalCache = new THREE.CanvasTexture(canvas)
  decalCache.colorSpace = THREE.SRGBColorSpace
  return decalCache
}

/**
 * 按设备类型生成高模。
 * 未知类型回退到暖通机组: 园区里最典型的立式机组外形, 不会被误认成「空模型」。
 */
export function createDeviceModel(type: string, status: DeviceStatus): DeviceModelHandle {
  const parts = new Parts()
  const build = BUILDERS[type] ?? buildChiller
  build(parts, status)

  // 接地光环: 比真实阴影便宜, 又能把模型"钉"在地面上
  const decal = new THREE.Mesh(
    parts.track(new THREE.PlaneGeometry(1, 1)),
    parts.trackMaterial(
      new THREE.MeshBasicMaterial({
        map: decalTexture(),
        transparent: true,
        depthWrite: false,
        opacity: 0.95,
      }),
    ),
  )
  decal.rotation.x = -Math.PI / 2
  decal.position.y = 0.006
  decal.scale.setScalar(DECAL_SIZE[type] ?? 3.4)
  parts.add(decal)

  return { root: parts.root, dispose: () => parts.dispose() }
}
