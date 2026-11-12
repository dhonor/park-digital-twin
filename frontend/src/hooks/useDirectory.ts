import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'

export interface DirectoryEntry {
  kind: 'building' | 'device'
  id: string
  name: string
  /** 结果行右侧的补充信息: 楼栋类型/层数, 或设备类型/所属楼栋 */
  sub: string
  /** 预归一化的检索文本 (名称 + 编号 + 楼栋) */
  text: string
}

interface Directory {
  entries: DirectoryEntry[]
  /** 楼栋 id → 名称: 面包屑与设备条目都要用 */
  buildingNames: Record<string, string>
  /** 设备目录是否已取回: 区分"还没加载"与"确实没匹配" */
  loaded: boolean
  /** 首次聚焦搜索框时再拉设备目录, 不占首屏请求 */
  ensureDevices: () => void
}

/**
 * 楼栋 + 设备的轻量目录, 只服务于「搜索定位」与「设备→楼栋」跳转.
 *
 * 分两级加载:
 *   - 楼栋只有 12 条, 进场景后立即取, 面包屑要显示楼名;
 *   - 设备 200 条, 等用户真正点开搜索框再取 —— 首屏每多一个请求,
 *     都要跟 Cesium 的下载抢带宽.
 * 失败不弹错: 目录是提效能力, 拿不到也不该影响看园区.
 */
export function useDirectory(enabled: boolean): Directory {
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  const [buildingNames, setBuildingNames] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  const namesRef = useRef<Record<string, string>>({})
  const devicesStarted = useRef(false)

  useEffect(() => {
    if (!enabled) return
    let alive = true

    void (async () => {
      try {
        const buildings = await api.buildings()
        if (!alive) return
        const names: Record<string, string> = {}
        const items: DirectoryEntry[] = []
        for (const item of buildings.items) {
          names[item.id] = item.name
          items.push({
            kind: 'building',
            id: item.id,
            name: item.name,
            sub: `${item.id} · ${item.type_label} · ${item.floors}F · ${item.device_count} 台设备`,
            text: `${item.name} ${item.id}`.toLowerCase(),
          })
        }
        namesRef.current = names
        setBuildingNames(names)
        setEntries(items)
      } catch {
        /* 目录只影响检索, 失败静默降级 */
      }
    })()

    return () => {
      alive = false
    }
  }, [enabled])

  const ensureDevices = useCallback(() => {
    if (devicesStarted.current) return
    devicesStarted.current = true

    void (async () => {
      try {
        const devices = await api.devices({ lod: 2 })
        const names = namesRef.current
        const items: DirectoryEntry[] = devices.features.map((feature) => {
          const props = feature.properties as Record<string, unknown>
          const id = String(props.id ?? '')
          const name = String(props.name ?? id)
          const buildingId = props.building_id ? String(props.building_id) : ''
          const typeLabel = String(props.type_label ?? props.type ?? '')
          const floor = Number(props.floor ?? 0)
          return {
            kind: 'device',
            id,
            name,
            // 编号放最前: 同型号设备名称前半段完全相同, 只有尾部编号能区分,
            // 名称被省略号截断时至少编号还可读
            sub: `${id} · ${buildingId ? (names[buildingId] ?? buildingId) : '室外'}${
              floor ? ` ${floor}F` : ''
            } · ${typeLabel}`,
            text: `${name} ${id} ${buildingId}`.toLowerCase(),
          }
        })
        setEntries((previous) => [...previous, ...items])
      } catch {
        /* 同上: 搜索退化为只能按楼栋定位 */
      } finally {
        setLoaded(true)
      }
    })()
  }, [])

  return { entries, buildingNames, loaded, ensureDevices }
}
