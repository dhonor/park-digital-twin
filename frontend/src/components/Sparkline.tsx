interface Props {
  data: number[]
  width?: number
  height?: number
  stroke?: string
  fill?: string
}

/**
 * 单调三次插值的切线（Fritsch–Carlson）。
 * 折线直接连线在 24 点、300px 宽的画面里能明显看到拐角；用单调插值补出曲线，
 * 且保证每段内不越过两端点 —— 波峰不会被插值「鼓」出去，用能曲线的读数才不失真。
 */
function monotoneTangents(xs: number[], ys: number[]): number[] {
  const n = xs.length
  const slope: number[] = []
  for (let i = 0; i < n - 1; i += 1) {
    slope.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]))
  }

  const tangent = new Array<number>(n)
  tangent[0] = slope[0]
  tangent[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i += 1) {
    const prev = slope[i - 1]
    const next = slope[i]
    if (prev * next <= 0) {
      tangent[i] = 0 // 极值点：切线水平，避免过冲
      continue
    }
    const mean = (prev + next) / 2
    const a = mean / prev
    const b = mean / next
    const norm = a * a + b * b
    tangent[i] = norm > 9 ? (3 / Math.sqrt(norm)) * mean : mean
  }
  return tangent
}

function cubicPath(xs: number[], ys: number[]): string {
  const tangent = monotoneTangents(xs, ys)
  let d = `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`
  for (let i = 0; i < xs.length - 1; i += 1) {
    const dx = (xs[i + 1] - xs[i]) / 3
    const c1x = xs[i] + dx
    const c1y = ys[i] + tangent[i] * dx
    const c2x = xs[i + 1] - dx
    const c2y = ys[i + 1] - tangent[i + 1] * dx
    d +=
      ` C${c1x.toFixed(1)},${c1y.toFixed(1)}` +
      ` ${c2x.toFixed(1)},${c2y.toFixed(1)}` +
      ` ${xs[i + 1].toFixed(1)},${ys[i + 1].toFixed(1)}`
  }
  return d
}

export function Sparkline({
  data,
  width = 300,
  height = 64,
  stroke = '#35C3FF',
  fill = 'rgba(53,195,255,0.16)',
}: Props) {
  if (!data.length) return <div className="spark-empty">无数据</div>

  const max = Math.max(...data)
  const min = Math.min(...data)
  const span = max - min || 1
  const top = 6
  const bottom = height - 4
  const step = data.length > 1 ? width / (data.length - 1) : width

  const xs = data.map((_, index) => index * step)
  const ys = data.map((value) => bottom - ((value - min) / span) * (bottom - top))

  if (data.length === 1) {
    return (
      <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <circle cx={width / 2} cy={(top + bottom) / 2} r={2.2} fill={stroke} />
      </svg>
    )
  }

  const path = cubicPath(xs, ys)
  const area = `${path} L${width},${height} L0,${height} Z`

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={area} fill={fill} stroke="none" />
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
