import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { api } from '../api/client'
import type { TwinScene } from '../cesium/scene'
import type { LayerCatalog, LightweightStats } from '../types'

interface Options {
  ready: boolean
  catalog: LayerCatalog | null
  lod: number
  sceneRef: MutableRefObject<TwinScene | null>
  visibilityRef: MutableRefObject<Record<string, boolean>>
  onStats: (stats: Record<string, LightweightStats>) => void
  onLoading: (loading: boolean) => void
  onError: (message: string) => void
  notify: (text: string) => void
}

/**
 * 按 LOD 拉取七个图层并装载进场景.
 *
 * 从 App 里抽出来的原因:
 *   1. 它只关心「图层集合」, 与面板/选中状态无关;
 *   2. LOD 切换是整屏重载, 逻辑长且有自己的完成态与提示文案, 混在 App 里很难读.
 * 回调统一走 ref, 保证依赖只有 ready/catalog/lod —— 否则每次渲染都会重拉一遍七个图层.
 */
export function useLayerSet({
  ready,
  catalog,
  lod,
  sceneRef,
  visibilityRef,
  onStats,
  onLoading,
  onError,
  notify,
}: Options): void {
  // 首次装载不算"切档", 不弹降幅提示
  const firstLoad = useRef(true)
  const handlers = useRef({ onStats, onLoading, onError, notify })
  handlers.current = { onStats, onLoading, onError, notify }

  useEffect(() => {
    if (!ready || !catalog) return
    const { onStats: setStats, onLoading, onError: fail, notify: toast } = handlers.current
    let cancelled = false
    onLoading(true)

    void (async () => {
      try {
        const entries = await Promise.all(
          catalog.layers.map(
            async (layer) => [layer.key, await api.layer(layer.key, { lod })] as const,
          ),
        )
        if (cancelled) return
        const next: Record<string, LightweightStats> = {}
        // 先全部取到再统一装载, 避免出现「一半旧 LOD 一半新 LOD」的中间态
        for (const [key, fc] of entries) {
          sceneRef.current?.setLayer(key, fc)
          sceneRef.current?.setLayerVisible(key, visibilityRef.current[key] ?? true)
          if (fc._lightweight) next[key] = fc._lightweight
        }
        setStats(next)
        if (!firstLoad.current) {
          const meta = catalog.lods.find((item) => item.lod === lod)
          const totalOut = Object.values(next).reduce(
            (sum, item) => sum + item.bytes.gzip_output,
            0,
          )
          const totalSrc = Object.values(next).reduce(
            (sum, item) => sum + item.bytes.gzip_source,
            0,
          )
          const pct = totalSrc ? Math.round((1 - totalOut / totalSrc) * 100) : 0
          const detail = meta
            ? meta.bbox_only
              ? `${meta.tolerance_m}m 抽稀 + 包络框`
              : meta.tolerance_m > 0
                ? `${meta.tolerance_m}m 抽稀`
                : '不抽稀'
            : ''
          const features = Object.values(next).reduce((sum, item) => sum + item.features, 0)
          toast(
            `${meta?.label ?? ''}视图 · ${detail} · ${features} 个要素 · 传输 ${(totalOut / 1024).toFixed(1)} KB（gzip -${pct}%）`,
          )
        }
        firstLoad.current = false
        if (new URLSearchParams(location.search).has('debug')) {
          document.title = JSON.stringify(sceneRef.current?.debugInfo() ?? {})
        }
      } catch (err) {
        if (!cancelled) fail(String(err))
      } finally {
        if (!cancelled) onLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [ready, catalog, lod, sceneRef, visibilityRef])
}
