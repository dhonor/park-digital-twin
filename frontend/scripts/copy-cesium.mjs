// 把 Cesium 的静态资源拷到 public/cesium，由 window.CESIUM_BASE_URL 指向。
// 不依赖 vite-plugin-cesium，避免插件与 Cesium 版本漂移。
import { cp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'node_modules/cesium/Build/Cesium')
const target = resolve(root, 'public/cesium')
const stampFile = resolve(target, '.cesium-version')

const pkg = JSON.parse(await readFile(resolve(root, 'node_modules/cesium/package.json'), 'utf8'))

try {
  const stamp = (await readFile(stampFile, 'utf8')).trim()
  if (stamp === pkg.version) {
    console.log(`[cesium] 静态资源已就绪 (${pkg.version})`)
    process.exit(0)
  }
} catch {
  // 首次安装，继续拷贝
}

try {
  await readFile(resolve(source, 'Widgets/widgets.css'))
} catch {
  console.error('[cesium] 未找到 node_modules/cesium，请先执行 npm install')
  process.exit(1)
}

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(resolve(source, 'Assets'), resolve(target, 'Assets'), { recursive: true })
await cp(resolve(source, 'ThirdParty'), resolve(target, 'ThirdParty'), { recursive: true })
await cp(resolve(source, 'Workers'), resolve(target, 'Workers'), { recursive: true })
await cp(resolve(source, 'Widgets'), resolve(target, 'Widgets'), { recursive: true })
await writeFile(stampFile, pkg.version, 'utf8')
console.log(`[cesium] 已拷贝静态资源 (${pkg.version}) -> public/cesium`)
