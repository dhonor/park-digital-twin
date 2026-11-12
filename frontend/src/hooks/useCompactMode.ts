import { useEffect, useState } from 'react'

/** 手机/窄屏阈值: 768 的 iPad 竖屏仍按完整三维处理 */
const COMPACT_WIDTH = 760

function detect(): boolean {
  if (typeof window === 'undefined') return false
  const nav = navigator as Navigator & {
    deviceMemory?: number
    connection?: { saveData?: boolean }
  }
  // 省流量模式/低内存设备不加载三维: Cesium 运行时压缩后仍有 1.3MB
  if (nav.connection?.saveData) return true
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 2) return true
  return window.matchMedia(`(max-width: ${COMPACT_WIDTH}px)`).matches
}

/**
 * 是否为「窄屏/低端设备」形态.
 *
 * 三维场景是桌面与大屏一体机的形态; 手机上强行加载 Cesium 的代价是
 * 4.8MB 脚本 + WebGL 初始化, 主线程会长时间卡住, 首屏十几秒才有内容.
 * 这类设备改走静态摘要视图(CompactDashboard), 数据一样、交互更轻.
 */
export function useCompactMode(): boolean {
  const [compact, setCompact] = useState(detect)

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${COMPACT_WIDTH}px)`)
    const sync = () => setCompact(detect())
    query.addEventListener('change', sync)
    window.addEventListener('resize', sync)
    return () => {
      query.removeEventListener('change', sync)
      window.removeEventListener('resize', sync)
    }
  }, [])

  return compact
}
