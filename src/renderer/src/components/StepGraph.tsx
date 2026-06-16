import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine
} from 'recharts'
import { StepResponsePoint, StepMetrics, MechanismType } from '../types'

interface Props {
  data: StepResponsePoint[]
  unitLabel: string
  mechanismType: MechanismType
  metrics: StepMetrics | null
}

function formatTime(v: number): string {
  return v.toFixed(2) + 's'
}

function metricColor(key: string, value: number): string {
  if (key === 'overshoot') {
    if (value > 10) return 'var(--error)'
    if (value > 5) return 'var(--gold-bright)'
    return 'var(--success)'
  }
  return 'var(--text-secondary)'
}

function formatMetric(key: string, value: number, unitLabel: string): string {
  if (key === 'overshoot') return value.toFixed(1) + ' %'
  if (key === 'riseTime' || key === 'settlingTime') {
    if (value < 0) return '—'
    return value < 1 ? (value * 1000).toFixed(0) + ' ms' : value.toFixed(2) + ' s'
  }
  if (key === 'ssError') return value.toFixed(3) + ' ' + unitLabel
  return value.toFixed(3)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label, unitLabel }: any): JSX.Element | null {
  if (!active || !payload?.length) return null
  return (
    <div className="chart-tooltip">
      <div className="tooltip-time">{typeof label === 'number' ? label.toFixed(3) : label} s</div>
      {payload.map((p: { name: string; value: number; color: string }) => (
        <div key={p.name} className="tooltip-row" style={{ color: p.color }}>
          <span>{p.name}</span>
          <span>{typeof p.value === 'number' ? p.value.toFixed(3) : p.value} {unitLabel}</span>
        </div>
      ))}
    </div>
  )
}

export default function StepGraph({ data, unitLabel, metrics }: Props): JSX.Element {
  const hasData = data.length > 0

  const metricItems = metrics ? [
    { key: 'riseTime', label: 'Rise Time', value: metrics.riseTimeS },
    { key: 'overshoot', label: 'Overshoot', value: metrics.overshootPct },
    { key: 'settlingTime', label: 'Settling', value: metrics.settlingTimeS },
    { key: 'ssError', label: 'SS Error', value: metrics.steadyStateError }
  ] : []

  const setpointVal = hasData ? data[0].setpoint : null

  return (
    <div className="step-graph-panel">
      <div className="panel-header">
        <span className="panel-title">Step Response</span>
        {metrics && (
          <span className="score-badge">
            Score <strong>{metrics.score.toFixed(1)}</strong>
          </span>
        )}
      </div>

      <div className="chart-area">
        {hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
              <CartesianGrid
                strokeDasharray="4 4"
                stroke="rgba(30,45,61,0.8)"
                horizontal
                vertical
              />
              <XAxis
                dataKey="time"
                tickFormatter={formatTime}
                stroke="var(--text-muted)"
                tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                label={{ value: 'Time (s)', position: 'insideBottomRight', offset: -4, fill: 'var(--text-muted)', fontSize: 11 }}
              />
              <YAxis
                stroke="var(--text-muted)"
                tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                label={{ value: unitLabel, angle: -90, position: 'insideLeft', offset: 12, fill: 'var(--text-muted)', fontSize: 11 }}
                width={55}
              />
              <Tooltip content={<CustomTooltip unitLabel={unitLabel} />} />
              <Legend
                wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)', paddingTop: 4 }}
              />
              {setpointVal !== null && (
                <ReferenceLine
                  y={setpointVal}
                  stroke="rgba(59,130,246,0.25)"
                  strokeDasharray="8 4"
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
