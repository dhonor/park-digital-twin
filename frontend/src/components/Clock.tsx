import { useEffect, useState } from 'react'

function format(date: Date): string {
  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * 时钟单独做成叶子组件.
 * 每秒变化的状态如果放在 App 顶层, 会让整棵面板树(三个面板 + KPI + 状态栏)
 * 跟着每秒重渲染一次; 放在这里则只有这一行文字更新.
 */
export function Clock() {
  const [text, setText] = useState(() => format(new Date()))

  useEffect(() => {
    const timer = window.setInterval(() => setText(format(new Date())), 1000)
    return () => window.clearInterval(timer)
  }, [])

  return <span className="clock">{text}</span>
}
