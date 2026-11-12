import { useState } from 'react'
import App from './App'
import { CompactDashboard } from './CompactDashboard'
import { useCompactMode } from './hooks/useCompactMode'

/**
 * 形态选择放在最外层: 窄屏/低端设备直接走轻量看板,
 * 连 App 都不挂载 —— 确保不会因为某个 import 把 Cesium 拉进首屏。
 */
export function Root() {
  const compact = useCompactMode()
  const [force3d, setForce3d] = useState(false)

  if (compact && !force3d) return <CompactDashboard onOpen3D={() => setForce3d(true)} />
  return <App />
}
