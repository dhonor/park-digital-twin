import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 前端只认 /api，后端可随时从内存仓库切到 PostGIS 而不影响前端
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
      },
      // 三维瓦片必须一起代理: 否则 /tiles/tileset.json 会被 Vite 的 SPA 兜底成 index.html,
      // 前端拿到一坨 HTML 去 JSON.parse, 外壳静默回退成矢量体块（开发模式下极难发现）
      '/tiles': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // 入口约 180KB; 唯一超限的是按需加载的三维场景块(含 Cesium), 属预期,
    // 因此阈值按它来设 —— 入口一旦膨胀到同量级, 构建日志里会立刻看出来
    chunkSizeWarningLimit: 5200,
    // 关掉 modulepreload polyfill: 它会把 vite 的预加载 helper 提到共享 chunk 里,
    // 结果入口为了拿这个 helper 又静态依赖了整个 Cesium chunk, 动态 import 白做
    modulePreload: { polyfill: false },
    /*
     * 不再用 manualChunks 手动切 vendor 块:
     * 把 'cesium' 指定成独立 chunk 后, Rollup 会把若干共享的小模块(如动态 import
     * 的预加载 helper)也塞进这个 chunk, 于是入口为了拿一个函数又静态依赖了 4.2MB 的
     * Cesium —— 动态 import 完全失效。交给 Rollup 按动态边界自然切分即可:
     * 三维场景是动态 import 的, Cesium/Three 自然落到那个按需 chunk 里。
     */
  },
})
