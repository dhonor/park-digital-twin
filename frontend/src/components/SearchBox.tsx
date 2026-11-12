import { useMemo, useRef, useState } from 'react'
import type { DirectoryEntry } from '../hooks/useDirectory'

interface Props {
  entries: DirectoryEntry[]
  loaded: boolean
  /** 首次交互时才拉设备目录, 避免和首屏三维资源抢带宽 */
  onDemand?: () => void
  onPickBuilding: (id: string) => void
  onPickDevice: (id: string) => void
}

const MAX_RESULTS = 8

/**
 * 园区检索.
 *
 * 12 栋楼、200 台设备靠鼠标在三维场景里点，是运维最高频的一步效率损耗；
 * 这里做成"输入即定位"：楼栋飞入楼栋视角，设备直接开设备面板并贴到机位。
 * 结果列表内联在左栏（不做浮层），避免被面板滚动容器裁切，也顺带适配触屏。
 */
export function SearchBox({ entries, loaded, onDemand, onPickBuilding, onPickDevice }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return []
    const prefix: DirectoryEntry[] = []
    const fuzzy: DirectoryEntry[] = []
    for (const entry of entries) {
      if (entry.id.toLowerCase().startsWith(keyword) || entry.text.startsWith(keyword)) {
        prefix.push(entry)
      } else if (entry.text.includes(keyword)) {
        fuzzy.push(entry)
      }
      if (prefix.length >= MAX_RESULTS) break
    }
    // 编号/名称前缀优先: 运维通常直接敲 DEV-B01-001 或楼栋名
    return [...prefix, ...fuzzy].slice(0, MAX_RESULTS)
  }, [entries, query])

  const pick = (entry: DirectoryEntry) => {
    if (entry.kind === 'building') onPickBuilding(entry.id)
    else onPickDevice(entry.id)
    setQuery('')
    setFocused(false)
    inputRef.current?.blur()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      setQuery('')
      inputRef.current?.blur()
      return
    }
    if (!results.length) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (index + 1) % results.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => (index - 1 + results.length) % results.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(results[Math.min(active, results.length - 1)])
    }
  }

  const showResults = focused && query.trim().length > 0

  return (
    <div className="search">
      <div className="search-field">
        <span className="search-icon" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          placeholder="搜索楼栋 / 设备"
          aria-label="搜索楼栋或设备"
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
            onDemand?.()
          }}
          onFocus={() => {
            setFocused(true)
            onDemand?.()
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
        {query ? (
          <button
            className="search-clear"
            aria-label="清空"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
          >
            ×
          </button>
        ) : (
          <span className="hint">
            {loaded ? `${entries.length} 项` : entries.length ? `${entries.length} 栋` : '加载中'}
          </span>
        )}
      </div>

      {showResults ? (
        <div className="search-results" role="listbox" aria-label="搜索结果">
          {results.length === 0 ? (
            <p className="search-empty">
              {loaded ? '没有匹配的楼栋或设备' : '正在加载楼栋与设备目录…'}
            </p>
          ) : (
            results.map((entry, index) => (
              <button
                key={`${entry.kind}-${entry.id}`}
                className={`search-row${index === Math.min(active, results.length - 1) ? ' is-active' : ''}`}
                role="option"
                aria-selected={index === Math.min(active, results.length - 1)}
                // mousedown 会先于 input blur, preventDefault 保证点击不被"失焦收起"吃掉
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(entry)}
              >
                <span className={`search-kind${entry.kind === 'device' ? ' is-device' : ''}`}>
                  {entry.kind === 'building' ? '楼' : '设备'}
                </span>
                <span className="search-name">
                  <strong>{entry.name}</strong>
                  <em>{entry.sub}</em>
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
