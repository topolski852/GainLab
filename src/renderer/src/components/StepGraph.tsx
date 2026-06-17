import { useState, useRef, useEffect } from 'react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ReferenceArea,
} from 'recharts'
import { StepResponsePoint, StepMetrics, MechanismType } from '../types'

interface Props {
  data: StepResponsePoint[]
  segmentBoundaries: number[]
  unitLabel: string
  mechanismType: MechanismType
  metrics: StepMetrics | null
}

function metricColor(key: string, value: number): string {
  if (key === 'overshoot') {
    if (value > 10) return 'var(--error)'
    if (value > 5)  return 'var(--gold-bright)'
    return 'var(--success)'
  }
  if (key === 'oscillations') {
    if (value >= 3) return 'var(--error)'
    if (value >= 1) return 'var(--gold-bright)'
    return 'var(--success)'
  }
  return 'var(--text-secondary)'
}

function formatMetric(key: string, value: number, unitLabel: string): string {
  if (key === 'overshoot')    return value.toFixed(1) + ' %'
  if (key === 'oscillations') return value === 0 ? 'None' : `${value}`
  if (key === 'riseTime' || key === 'settlingTime') {
    if (value < 0) return '—'
    return value < 1 ? (value * 1000).toFixed(0) + ' ms' : value.toFixed(2) + ' s'
  }
  if (key === 'ssError') return value.toFixed(3) + ' ' + unitLabel
  return value.toFixed(3)
}

function formatDelta(dt: number): string {
  const abs = Math.abs(dt)
  if (abs < 1) return `${(abs * 1000).toFixed(0)} ms`
  return `${abs.toFixed(3)} s`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label, unitLabel, markerTime }: any): JSX.Element | null {
  if (!active || !payload?.length) return null
  const t = typeof label === 'number' ? label : parseFloat(label)
  const dt = markerTime != null ? t - markerTime : null
  return (
    <div className="chart-tooltip">
      <div className="tooltip-time">{t.toFixed(3)} s</div>
      {payload.map((p: { name: string; value: number; color: string }) => (
        <div key={p.name} className="tooltip-row" style={{ color: p.color }}>
          <span>{p.name}</span>
          <span>{typeof p.value === 'number' ? p.value.toFixed(3) : p.value} {unitLabel}</span>
        </div>
      ))}
      {dt != null && (
        <div className="tooltip-row tooltip-delta">
          <span>Δt</span>
          <span>{dt >= 0 ? '+' : '−'}{formatDelta(dt)}</span>
        </div>
      )}
    </div>
  )
}

export default function StepGraph({ data, segmentBoundaries, unitLabel, metrics }: Props): JSX.Element {
  const hasData = data.length > 0
  const dataMin = hasData ? data[0].time : 0
  const dataMax = hasData ? data[data.length - 1].time : 1

  // Zoom state
  const [xDomain, setXDomain] = useState<[number, number] | null>(null)
  const [selArea, setSelArea]  = useState<[number, number] | null>(null)  // visual drag box

  // Time marker state
  const [markerTime, setMarkerTime] = useState<number | null>(null)
  const [hoverTime, setHoverTime]   = useState<number | null>(null)

  // Mutable refs — avoid stale closures in event handlers
  const containerRef    = useRef<HTMLDivElement>(null)
  const hoverTimeRef    = useRef<number | null>(null)
  const xDomainRef      = useRef<[number, number] | null>(null)
  const selStartRef     = useRef<number | null>(null)
  const isSelectingRef  = useRef(false)

  // Reset on new data
  useEffect(() => {
    setXDomain(null)
    setMarkerTime(null)
    setSelArea(null)
    setHoverTime(null)
    selStartRef.current   = null
    isSelectingRef.current = false
  }, [data])

  useEffect(() => { xDomainRef.current = xDomain }, [xDomain])

  // Scroll-to-zoom (non-passive so we can preventDefault)
  useEffect(() => {
    const el = containerRef.current
    if (!el || !hasData) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const [left, right] = xDomainRef.current ?? [dataMin, dataMax]
      const center = hoverTimeRef.current ?? (left + right) / 2
      const factor = e.deltaY > 0 ? 1.3 : 1 / 1.3
      const newLeft  = Math.max(dataMin, center - (center - left)  * factor)
      const newRight = Math.min(dataMax, center + (right - center) * factor)
      if (newRight - newLeft > 0.001) setXDomain([newLeft, newRight])
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [hasData, dataMin, dataMax])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleMouseDown(e: any): void {
    const t = e?.activeLabel != null ? Number(e.activeLabel) : null
    if (t == null) return
    selStartRef.current    = t
    isSelectingRef.current = true
    setSelArea([t, t])
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleMouseMove(e: any): void {
    const t = e?.activeLabel != null ? Number(e.activeLabel) : null
    hoverTimeRef.current = t
    setHoverTime(t)
    if (isSelectingRef.current && selStartRef.current != null && t != null) {
      const l = Math.min(selStartRef.current, t)
      const r = Math.max(selStartRef.current, t)
      setSelArea([l, r])
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleMouseUp(e: any): void {
    if (!isSelectingRef.current) return
    isSelectingRef.current = false

    const start = selStartRef.current
    const t     = e?.activeLabel != null ? Number(e.activeLabel) : start
    selStartRef.current = null
    setSelArea(null)

    if (start == null || t == null) return
    const dist = Math.abs(t - start)

    if (dist < 0.03) {
      // Click: clear existing marker, or place new one
      if (markerTime != null) {
        setMarkerTime(null)
      } else {
        setMarkerTime(t)
      }
    } else {
      // Drag: zoom
      setXDomain([Math.min(start, t), Math.max(start, t)])
    }
  }

  function handleMouseLeave(): void {
    hoverTimeRef.current   = null
    setHoverTime(null)
    if (isSelectingRef.current) {
      isSelectingRef.current = false
      selStartRef.current    = null
      setSelArea(null)
    }
  }

  function handleDoubleClick(): void {
    setXDomain(null)
  }

  const isZoomed     = xDomain != null
  const changeMarkers = segmentBoundaries.slice(1)
  const metricItems   = metrics ? [
    { key: 'riseTime',     label: 'Rise Time',    value: metrics.riseTimeS },
    { key: 'overshoot',    label: 'Overshoot',    value: metrics.overshootPct },
    { key: 'settlingTime', label: 'Settling',     value: metrics.settlingTimeS },
    { key: 'ssError',      label: 'SS Error',     value: metrics.steadyStateError },
    { key: 'oscillations', label: 'Oscillations', value: metrics.oscillations },
  ] : []

  const effectiveDomain: [number, number] = xDomain ?? [dataMin, dataMax]

  return (
    <div className="step-graph-panel">
      <div className="panel-header">
        <span className="panel-title">Step Response</span>
        {metrics && (
          <span className="score-badge">
            Score <strong>{metrics.score.toFixed(1)}</strong>
          </span>
        )}
        {segmentBoundaries.length > 1 && (
          <span className="segment-count">
            {segmentBoundaries.length} steps
          </span>
        )}
        {isZoomed && (
          <button
            className="btn-reset-zoom"
            onClick={() => { setXDomain(null); setMarkerTime(null) }}
          >
            × Reset Zoom
          </button>
        )}
        {markerTime != null && hoverTime != null && hoverTime !== markerTime && (
          <span className="marker-delta">
            Δt {hoverTime >= markerTime ? '+' : '−'}{formatDelta(hoverTime - markerTime)}
          </span>
        )}
      </div>

      <div
        className={`chart-area${isSelectingRef.current ? ' chart-selecting' : ''}`}
        ref={containerRef}
      >
        {hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 8, right: 24, left: 8, bottom: 8 }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
              onDoubleClick={handleDoubleClick}
            >
              <CartesianGrid
                strokeDasharray="4 4"
                stroke="rgba(30,45,61,0.8)"
                horizontal
                vertical
              />
              <XAxis
                dataKey="time"
                type="number"
                domain={effectiveDomain}
                tickFormatter={v => v.toFixed(2) + 's'}
                stroke="var(--text-muted)"
                tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                label={{ value: 'Time (s)', position: 'insideBottomRight', offset: -4, fill: 'var(--text-muted)', fontSize: 11 }}
                allowDataOverflow
              />
              <YAxis
                stroke="var(--text-muted)"
                tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                label={{ value: unitLabel, angle: -90, position: 'insideLeft', offset: 12, fill: 'var(--text-muted)', fontSize: 11 }}
                width={55}
              />
              <Tooltip
                content={<CustomTooltip unitLabel={unitLabel} markerTime={markerTime} />}
                isAnimationActive={false}
              />
              <Legend
                wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)', paddingTop: 4 }}
              />

              {/* Segment change markers */}
              {changeMarkers.map(t => (
                <ReferenceLine
                  key={t}
                  x={t}
                  stroke="rgba(240,180,41,0.30)"
                  strokeDasharray="4 3"
                  strokeWidth={1}
                />
              ))}

              {/* Drag-to-zoom selection box */}
              {selArea && (
                <ReferenceArea
                  x1={selArea[0]}
                  x2={selArea[1]}
                  fill="rgba(96,165,250,0.10)"
                  stroke="rgba(96,165,250,0.4)"
                  strokeWidth={1}
                />
              )}

              {/* Δt region between marker and hover */}
              {markerTime != null && hoverTime != null && Math.abs(hoverTime - markerTime) > 0.015 && (
                <>
                  <ReferenceArea
                    x1={Math.min(markerTime, hoverTime)}
                    x2={Math.max(markerTime, hoverTime)}
                    fill="rgba(240,180,41,0.07)"
                    stroke="none"
                    label={{
                      value: `Δt ${hoverTime >= markerTime ? '+' : '−'}${formatDelta(hoverTime - markerTime)}`,
                      position: 'insideTop',
                      fill: 'rgba(240,180,41,0.90)',
                      fontSize: 11,
                    }}
                  />
                  <ReferenceLine
                    x={hoverTime}
                    stroke="rgba(240,180,41,0.40)"
                    strokeWidth={1}
                    strokeDasharray="4 3"
                  />
                </>
              )}

              {/* Time marker line */}
              {markerTime != null && (
                <ReferenceLine
                  x={markerTime}
                  stroke="rgba(240,180,41,0.85)"
                  strokeWidth={1.5}
                  label={{
                    value: markerTime.toFixed(3) + 's',
                    position: 'insideTopRight',
                    fill: 'rgba(240,180,41,0.85)',
                    fontSize: 10,
                  }}
                />
              )}

              <Line
                type="monotone"
                dataKey="setpoint"
                name="Setpoint"
                stroke="var(--blue-bright)"
                strokeWidth={1.5}
                strokeDasharray="6 3"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="actual"
                name="Actual"
                stroke="var(--gold-bright)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="chart-empty">
            <div className="chart-empty-icon">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                <rect x="4" y="36" width="40" height="2" fill="var(--border-accent)" />
                <rect x="4" y="4" width="2" height="32" fill="var(--border-accent)" />
                <polyline
                  points="6,32 14,20 22,22 32,10 42,14"
                  stroke="var(--blue-dim)"
                  strokeWidth="1.5"
                  strokeDasharray="3 2"
                  fill="none"
                />
              </svg>
            </div>
            <p>Run a simulation to see the step response</p>
          </div>
        )}
      </div>

      {/* Metrics bar */}
      <div className="metrics-bar">
        {metricItems.length > 0 ? (
          metricItems.map(m => (
            <div key={m.key} className="metric-chip">
              <span className="metric-label">{m.label}</span>
              <span className="metric-value" style={{ color: metricColor(m.key, m.value) }}>
                {formatMetric(m.key, m.value, unitLabel)}
              </span>
            </div>
          ))
        ) : (
          <span className="metric-placeholder">Metrics appear after first test</span>
        )}
      </div>
    </div>
  )
}
