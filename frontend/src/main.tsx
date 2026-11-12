import { createRoot } from 'react-dom/client'
import { Root } from './Root'
import './styles/global.css'

// 不用 StrictMode: 开发态双挂载会重复创建 WebGL 上下文, 与 Cesium Viewer 冲突
const container = document.getElementById('root')
if (!container) throw new Error('#root 不存在')

createRoot(container).render(<Root />)
