import { Gains, StepMetrics, MechanismType, OptimizerEntry } from '../types'

interface Props {
  gains: Gains
  metrics: StepMetrics | null
  mechanismType: MechanismType
  testCount: number
  isRunning: boolean
  canSuggest: boolean
  history: OptimizerEntry[]
  onGainsChange: (g: Gains) => void
  onRunTest: () => void
  onSuggest: () => void
  onExport: () => void
}

const GAIN_DEFS: { key: keyof Gains; label: string; unit: string; step: number; min: number }[] = [
  { key: 'kP', label: 'kP', unit: 'V/err',   step: 0.001, min: 0 },
  { key: 'kI', label: 'kI', unit: 'V/err·s', step: 0.0001, min: 0 },
  { key: 'kD', label: 'kD', unit: 'V·s/err', step: 0.001, min: 0 },
  { key: 'kS', label: 'kS', unit: 'V',       step: 0.01,  min: 0 },
  { key: 'kV', label: 'kV', unit: 'V·s/rot', step: 0.001, min: 0 },
  { key: 'kA', label: 'kA', unit: 'V·s²/rot',step: 0.001, min: 0 },
  { key: 'kG', label: 'kG', unit: 'V',       step: 0.01,  min: 0 }
]

function scoreColor(score: number): string {
  if (score < 5) return 'var(--success)'
  if (score < 15) return 'var(--gold-bright)'
  return 'var(--error)'
}

export default function GainsPanel({
  gains, metrics, mechanismType, testCount, isRunning,
  canSuggest, history, onGainsChange, onRunTest, onSuggest, onExport
}: Props): JSX.Element {

  const showKG = mechanismType === 'arm' || mechanismType === 'elevator'
  const visibleGains = GAIN_DEFS.filter(g => g.key !== 'kG' || showKG)

  function setGain(key: keyof Gains, val: string): void {
    const n = parseFloat(val)
    if (!isNaN(n)) onGainsChange({ ...gains, [key]: n })
  }

  const bestEntry = history.length > 0
    ? history.reduce((b, e) => e.metrics.score < b.metrics.score ? e : b)
    : null

  return (
    <div className="gains-panel">
      <div className="panel-title">Gains <span className="gains-subtitle">Phoenix 6 · Slot 0</span></div>

      {/* Gain inputs */}
      <div className="gains-grid">
        {visibleGains.map(def => (
          <div key={def.key} className="gain-row">
            <label className="gain-label">{def.label}</label>
            <input
              type="number"
              className="gain-input"
              value={gains[def.key]}
              step={def.step}
              min={def.min}
              onChange={e => setGain(def.key, e.target.value)}
            />
            <span className="gain-unit">{def.unit}</span>
          </div>
        ))}
      </div>

      <div className="section-divider" />

      {/* Metrics */}
      <div className="section-label">Results</div>
      {metrics ? (
        <div className="metrics-list">
          <MetricRow label="Rise Time"
            value={metrics.riseTimeS < 0 ? '—' : metrics.riseTimeS < 1
              ? (metrics.riseTimeS * 1000).toFixed(0) + ' ms'
              : metrics.riseTimeS.toFixed(3) + ' s'}
          />
          <MetricRow label="Overshoot"
            value={metrics.overshootPct.toFixed(1) + ' %'}
            color={metrics.overshootPct > 10 ? 'var(--error)' : metrics.overshootPct > 5 ? 'var(--gold-bright)' : 'var(--success)'}
          />
          <MetricRow label="Settling"
            value={metrics.settlingTimeS < 0 ? '—' : metrics.settlingTimeS < 1
              ? (metrics.settlingTimeS * 1000).toFixed(0) + ' ms'
              : metrics.settlingTimeS.toFixed(3) + ' s'}
          />
          <MetricRow label="SS Error" value={metrics.steadyStateError.toFixed(4)} />
          <div className="metric-score-row">
            <span className="metric-score-label">Score</span>
            <span className="metric-score-value" style={{ color: scoreColor(metrics.score) }}>
              {metrics.score.toFixed(2)}
            </span>
            <span className="metric-score-hint">(lower = better)</span>
          </div>
        </div>
      ) : (
        <div className="metrics-empty">No results yet</div>
      )}

      <div className="section-divider" />

      {/* Actions */}
      <div className="action-group">
        <button
          className={`btn btn-primary ${isRunning ? 'loading' : ''}`}
          onClick={onRunTest}
          disabled={isRunning}
        >
          {isRunning ? (
            <><span className="spinner" /> Running…</>
          ) : (
            <>▶ Run Test</>
          )}
        </button>

        <button
          className="btn btn-secondary"
          onClick={onSuggest}
          disabled={!canSuggest || isRunning}
          title={!canSuggest ? `Run ${2 - testCount} more test${testCount === 1 ? '' : 's'} to enable optimizer` : 'Suggest gains via Bayesian optimizer'}
        >
          ◆ Suggest Next Gains
        </button>

        <button
          className="btn btn-export"
          onClick={onExport}
          disabled={testCount === 0}
        >
          ↗ Export Java
        </button>
      </div>

      <div className="optimizer-status">
        {testCount === 0 && <span>Run at least 2 tests to activate the Bayesian optimizer</span>}
        {testCount === 1 && <span>One more test to activate optimizer…</span>}
        {testCount >= 2 && <span className="optimizer-active">
          ◆ Optimizer active · {testCount} experiment{testCount !== 1 ? 's' : ''}
        </span>}
      </div>

      {/* History */}
      {history.length > 0 && (
        <>
          <div className="section-divider" />
          <div className="section-label">History</div>
          <div className="history-list">
            {[...history].reverse().slice(0, 8).map((entry, i) => {
              const isBest = bestEntry && entry.metrics.score === bestEntry.metrics.score
              return (
                <button
                  key={entry.testIndex}
                  className={`history-entry ${isBest ? 'best' : ''}`}
                  onClick={() => onGainsChange(entry.gains)}
                  title="Click to restore these gains"
                >
                  <span className="history-index">#{history.length - i}</span>
                  <div className="history-bar-wrap">
                    <div
                      className="history-bar"
                      style={{ width: `${Math.max(4, 100 - entry.metrics.score * 3)}%` }}
                    />
                  </div>
                  <span className="history-score" style={{ color: scoreColor(entry.metrics.score) }}>
                    {entry.metrics.score.toFixed(1)}
                  </span>
                  {isBest && <span className="history-best-tag">best</span>}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function MetricRow({ label, value, color }: { label: string; value: string; color?: string }): JSX.Element {
  return (
    <div className="metric-list-row">
      <span className="metric-list-label">{label}</span>
      <span className="metric-list-value" style={color ? { color } : undefined}>{value}</span>
    </div>
  )
}
