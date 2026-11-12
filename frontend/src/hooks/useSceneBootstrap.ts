import { useEffect, useRef } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { api } from '../api/client'
import type { HoverInfo, TwinScene } from '../cesium/scene'
import { describe } from '../lib/describe'
import type { LayerCatalog, Park } from '../types'

interface Options {
  containerRef: MutableRefObject<HTMLDivElement | null>
  sceneRef: MutableRefObject<TwinScene | null>
  visibilityRef: MutableRefObject<Record<string, boolean>>
  onPark: Dispatch<SetStateAction<Park | null>>
  onCatalog: Dispatch<SetStateAction<LayerCatalog | null>>
  onLod: Dispatch<SetStateAction<number>>
  onVisibility: Dispatch<SetStateAction<Record<string, boolean>>>
  onReady: Dispatch<SetStateAction<boolean>>
  onError: Dispatch<SetStateAction<string | null>>
  loadBuilding: (id: string) => Promise<void>
  loadDevice: (id: string) => Promise<void>
  resetSelection: () => void
  onHover: (info: HoverInfo | null) => void
  onCursor: (pos: { lon: number; lat: number } | null) => void
}

/**
 * 场景引导: 取园区元数据 → 建 Cesium 场景 → 取图层目录 → 落初始 LOD 与图层可见性.
 *
 * 这里刻意用 ref 持有回调, effect 只在挂载时执行一次:
 * TwinScene 构造一次要建 WebGL 上下文与瓦片调度, 依赖数组里只要有一个函数身份变化,
 * 就会「销毁场景 → 重建 → 相机与图层状态全丢」, 症状是画面闪一下回到初始视角。
 *
 * 初始化顺序也有讲究: ready 必须在场景建好之后置位, 否则 useLayerSet 会拿着空 sceneRef 装载,
 * 表现为首屏空白、切换一次 LOD 才出图。
 */
export function useSceneBootstrap(options: Options): void {
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    const container = latest.current.containerRef.current
    if (!container) return
    let disposed = false
    let scene: TwinScene | null = null

    void (async () => {
      const current = latest.current
      try {
        // Cesium 运行时接近 5MB(未压缩): 静态 import 会让浏览器先下载并编译它,
        // 首帧被拖到几秒之后. 这里改成动态 import, 并把园区元数据/图层目录的请求
        // 与它并行发起 —— React 外壳先上屏, 三维场景随后接管画布.
        const [parkData, catalogData, { TwinScene }] = await Promise.all([
          api.park(),
          api.layers(),
          import('../cesium/scene'),
        ])
        if (disposed) return
        current.onPark(parkData)

        scene = new TwinScene(container, parkData, {
          onPickBuilding: (id) => void current.loadBuilding(id),
          onPickDevice: (id) => void current.loadDevice(id),
          onBlank: () => current.resetSelection(),
          onHover: current.onHover,
          onCursor: current.onCursor,
        })
        current.sceneRef.current = scene
        current.onCatalog(catalogData)
        // 支持 /?lod=0|1|2 直接指定视图精度, 方便对比与分享
        // 注意 Number(null) === 0, 必须先判空, 否则不传参也会落到 LOD0
        const lodParam = new URLSearchParams(location.search).get('lod')
        const parsedLod = lodParam === null ? Number.NaN : Number(lodParam)
        current.onLod([0, 1, 2].includes(parsedLod) ? parsedLod : catalogData.default_lod)

        const initial = Object.fromEntries(
          catalogData.layers.map((layer) => [layer.key, layer.default_visible]),
        )
        current.visibilityRef.current = initial
        current.onVisibility(initial)
        // ready 放最后: 它同时触发图层装载(useLayerSet)与实时通道建立,
        // 必须保证那时场景、目录、LOD 都已就位
        current.onReady(true)
      } catch (err) {
        if (!disposed) latest.current.onError(describe(err))
      }
    })()

    return () => {
      disposed = true
      scene?.dispose()
      latest.current.sceneRef.current = null
    }
  }, [])
}
