import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { api } from '../api/client'
import type { TwinScene } from '../cesium/scene'
import type { TilesetInfo } from '../types'

interface Options {
  ready: boolean
  sceneRef: MutableRefObject<TwinScene | null>
  notify: (text: string) => void
  onInfo: Dispatch<SetStateAction<TilesetInfo | null>>
  onMode: Dispatch<SetStateAction<'model' | 'vector'>>
  onLoading: Dispatch<SetStateAction<boolean>>
  onProgress: Dispatch<SetStateAction<number>>
}

/**
 * 三维外壳 (3D Tiles) 挂载.
 *
 * 失败与不可用都只是「降级到矢量体块」, 不抛错、不阻塞场景:
 * 瓦片缺失、跨域、显卡吃不下大 glb 时, 主链路必须照常出图。
 */
export function useShell({
  ready,
  sceneRef,
  notify,
  onInfo,
  onMode,
  onLoading,
  onProgress,
}: Options): void {
  useEffect(() => {
    if (!ready) return
    let alive = true

    void (async () => {
      const scene = sceneRef.current
      if (!scene) return
      try {
        const info = await api.tileset()
        if (!alive) return
        onInfo(info)
        if (!info.available || !info.url) return

        onLoading(true)
        const ok = await scene.loadShell(info.url, (percent, done) => {
          if (!alive) return
          onProgress(percent)
          if (done) onLoading(false)
        })
        if (!alive) return
        onLoading(false)
        if (ok) {
          // ?shell=vector 可强制回到矢量体块, 便于对比与排障
          const forced = new URLSearchParams(location.search).get('shell') === 'vector'
          const nextMode = forced ? 'vector' : 'model'
          onMode(nextMode)
          scene.setShellMode(nextMode)
        } else {
          notify('三维外壳加载失败，已回退矢量体块')
        }
      } catch {
        if (alive) onInfo(null)
      }
    })()

    return () => {
      alive = false
    }
  }, [ready, sceneRef, notify, onInfo, onMode, onLoading, onProgress])
}
