import { useState } from 'react'
import { Gains, StepMetrics, MechanismConfig, OptimizerEntry, PhaseInfo } from '../types'
import { MOTORS } from '../physics/motors'
import { displayUnitLabel } from '../physics/simulator'

interface Props {
  gains: Gains
  metrics: StepMetrics | null
  mechanism: MechanismConfig
  nominalSetpoint: number
  testCount: number
  isRunning: boolean
  phaseInfo: PhaseInfo
  history: OptimizerEntry[]
  autoRunning: boolean
  autoRunProgress: { done: number; total: number }
  onGainsChange: (g: Gains) => void
  onRunTest: () => void
  onSuggest: () => void
  onExport: () => void
  onStartAutoRun: (n: number) => void
  onStopAutoRun: () => void
}

const GAIN_DEFS: { key: keyof Gains; label: string; unit: string; step: number; min: number }[] = [
  { key: 'kP', label: 'kP', unit: 'V/err',    step: 0.001,  min: 0 },
  { key: 'kI', label: 'kI', unit: 'V/err·s',  step: 0.0001, min: 0 },
  { key: 'kD', label: 'kD', unit: 'V·s/err',  step: 0.001,  min: 0 },
  { key: 'kS', label: 'kS', unit: 'V',        step: 0.01,   min: 0 },
  { key: 'kV', label: 'kV', unit: 'V·s/rot',  step: 0.001,  min: 0 },
  { key: 'kA', label: 'kA', unit: 'V·s²/rot', step: 0.001,  min: 0 },
  { key: 'kG', label: 'kG', unit: 'V',        step: 0.01,   min: 0 }
]

function scoreColor(score: number): string {
  if (score < 5)  return 'var(--success)'
  if (score < 15) return 'var(--gold-bright)'
  return 'var(--error)'
}

function oscColor(n: number): string {
  if (n === 0) return 'var(--success)'
  if (n <= 2)  return 'var(--gold-bright)'
  return 'var(--error)'
}

function fmtTime(s: number): string {
  if (s < 0)  return '—'
  if (s < 1)  return (s * 1000).toFixed(0) + 'ms'
  return s.toFixed(3) + 's'
}

function fmtPct(v: number): string { return v.toFixed(1) + '%' }

// ─── Log formatter ────────────────────────────────────────────────────────────

function buildLog(history: OptimizerEntry[], mechanism: MechanismConfig, nominalSetpoint: number): string {
  const unitLabel = displayUnitLabel(mechanism)
  const motor     = MOTORS[mechanism.motorType]
  const motorName = motor?.name ?? mechanism.motorType
  const mechLabel = mechanism.type.charAt(0).toUpperCase() + mechanism.type.slice(1)
  const now       = new Date().toLocaleString()

  const bestEntry = history.length > 0
    ? history.reduce((b, e) => e.metrics.score < b.metrics.score ? e : b)
    : null

  const line = '─'.repeat(64)
  const header = [
    `GainLab Test Log`,
    `Mechanism : ${mechLabel}  |  Motor: ${motorName}`,
    `Gear Ratio: ${mechanism.gearRatio}:1  |  Motors: ${mechanism.numMotors}`,
    `Setpoint  : ${nominalSetpoint} ${unitLabel}`,
    `Experiments: ${history.length}${bestEntry ? `  |  Best Score: ${bestEntry.metrics.score.toFixed(2)} (Test #${bestEntry.testIndex + 1})` : ''}`,
    `Generated : ${now}`,
    line,
  ].join('\n')

  const entries = history.map(entry => {
    const { gains, metrics, segmentMetrics, steps, testIndex } = entry
    const isBest = bestEntry?.testIndex === testIndex

    const gainsLine = `  Gains : kP=${gains.kP.toFixed(4)}  kI=${gains.kI.toFixed(4)}  kD=${gains.kD.toFixed(4)}  kS=${gains.kS.toFixed(4)}  kV=${gains.kV.toFixed(4)}  kA=${gains.kA.toFixed(4)}  kG=${gains.kG.toFixed(4)}`

    const stepsLine = `  Steps : ${steps.map(s => `${s.setpointDisplay} ${unitLabel} × ${s.durationS}s`).join('  →  ')}`

    const aggLine = [
      `  Agg   : Rise=${fmtTime(metrics.riseTimeS)}`,
      `Over=${fmtPct(metrics.overshootPct)}`,
      `Settle=${fmtTime(metrics.settlingTimeS)}`,
      `SSErr=${metrics.steadyStateError.toFixed(3)}`,
      `Osc=${metrics.oscillations}`,
      `Score=${metrics.score.toFixed(2)}${isBest ? ' ★ BEST' : ''}`,
    ].join('  ')

    const segLines = segmentMetrics.length > 1
      ? segmentMetrics.map((seg, i) => {
          const sp   = steps[i]?.setpointDisplay ?? '?'
          const prev = i > 0 ? (steps[i - 1]?.setpointDisplay ?? 0) : 0
          const dir  = i === 0 || sp > prev ? '↑' : '↓'
          return [
            `  Seg ${i + 1} (${sp} ${unitLabel} ${dir}):`,
            `Rise=${fmtTime(seg.riseTimeS)}`,
            `Over=${fmtPct(seg.overshootPct)}`,
            `Settle=${fmtTime(seg.settlingTimeS)}`,
            `SSErr=${seg.steadyStateError.toFixed(3)}`,
            `Osc=${seg.oscillations}`,
            `Score=${seg.score.toFixed(2)}`,
          ].join('  ')
        })
      : []

    return [`Test #${testIndex + 1}`, gainsLine, stepsLine, ...segLines, aggLine].join('\n')
  })

  const best = bestEntry ? [
    line,
    `★ BEST GAINS (Test #${bestEntry.testIndex + 1}  Score: ${bestEntry.metrics.score.toFixed(2)})`,
    `  kP=${bestEntry.gains.kP.toFixed(4)}  kI=${bestEntry.gains.kI.toFixed(4)}  kD=${bestEntry.gains.kD.toFixed(4)}`,
    `  kS=${bestEntry.gains.kS.toFixed(4)}  kV=${bestEntry.gains.kV.toFixed(4)}  kA=${bestEntry.gains.kA.toFixed(4)}  kG=${bestEntry.gains.kG.toFixed(4)}`,
  ].join('\n') : ''

  return [header, ...entries.map(e => e + '\n'), best].join('\n')
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function GainsPanel({
  gains, metrics, mechanism, nominalSetpoint, testCount, isRunning,
  phaseInfo, history, autoRunning, autoRunProgress,
  onGainsChange, onRunTest, onSuggest, onExport, onStartAutoRun, onStopAutoRun
}: Props): JSX.Element {

  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle')
  const [autoRunCount, setAutoRunCount] = useState(20)

  const showKG = mechanism.type === 'arm' || mechanism.type === 'elevator'
  const visibleGains = GAIN_DEFS.filter(g => g.key !== 'kG' || showKG)

  function setGain(key: keyof Gains, val: string): void {
    const n = parseFloat(val)
    if (!isNaN(n)) onGainsChange({ ...gains, [key]: n })
  }

  const bestEntry = history.length > 0
    ? history.reduce((b, e) => e.metrics.score < b.metrics.score ? e : b)
    : null

  const isStructured = phaseInfo.phase === 'structured'

  function copyLog(): void {
    if (history.length === 0) return
    const log = buildLog(history, mechanism, nominalSetpoint)
    navigator.clipboard.writeText(log).then(() => {
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 2000)
    }).catch(() => {})
  }

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

      {/* Optimizer phase indicator */}
      <div className="phase-indicator">
        <div className="phase-header">
          <span className={`phase-badge ${isStructured ? 'phase-structured' : 'phase-ucb'}`}>
            {phaseInfo.label}
          </span>
          <span className="phase-exp-count">{testCount} exp</span>
        </div>
        <div className="phase-description">{phaseInfo.description}</div>
        <div className="phase-progress-track">
          <div
            className={`phase-progress-fill ${isStructured ? 'phase-structured' : 'phase-ucb'}`}
            style={{ width: `${phaseInfo.progressPct}%` }}
          />
        </div>
      </div>

      <div className="section-divider" />

      {/* Results */}
      <div className="section-label">Results</div>
      {metrics ? (
        <div className="metrics-list">
          <MetricRow label="Rise Time"     value={fmtTime(metrics.riseTimeS)} />
          <MetricRow label="Overshoot"     value={fmtPct(metrics.overshootPct)}
            color={metrics.overshootPct > 10 ? 'var(--error)' : metrics.overshootPct > 5 ? 'var(--gold-bright)' : 'var(--success)'}
          />
          <MetricRow label="Settling"      value={fmtTime(metrics.settlingTimeS)} />
          <MetricRow label="SS Error"      value={metrics.steadyStateError.toFixed(4)} />
          <MetricRow label="Oscillations"
            value={metrics.oscillations === 0 ? 'None' : `${metrics.oscillations} crossing${metrics.oscillations !== 1 ? 's' : ''}`}
            color={oscColor(metrics.oscillations)}
          />
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
          disabled={isRunning || autoRunning}
        >
          {isRunning ? <><span className="spinner" /> Running…</> : <>▶ Run Test</>}
        </button>

        <button
          className="btn btn-secondary"
          onClick={onSuggest}
          disabled={isRunning || autoRunning}
          title={isStructured
            ? `Suggest next structured kP sweep (${phaseInfo.description})`
            : 'Suggest gains via Bayesian UCB optimizer'}
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

      {/* Auto-run */}
      <div className="section-divider" />
      {autoRunning ? (
        <div className="auto-run-active">
          <div className="auto-run-status">
            <span className="auto-run-spinner" />
            <span>Experiment {autoRunProgress.done + 1} of {autoRunProgress.total}</span>
          </div>
          <button className="btn btn-stop" onClick={onStopAutoRun}>■ Stop</button>
        </div>
      ) : (
        <div className="auto-run-controls">
          <label className="auto-run-label">Auto-Optimize</label>
          <div className="auto-run-row">
            <input
              type="number"
              className="auto-run-input"
              value={autoRunCount}
              min={1}
              max={200}
              onChange={e => setAutoRunCount(Math.max(1, parseInt(e.target.value) || 1))}
              title="Number of experiments to run automatically"
            />
            <span className="auto-run-unit">experiments</span>
            <button
              className="btn btn-auto-run"
              onClick={() => onStartAutoRun(autoRunCount)}
              disabled={isRunning}
              title={`Run ${autoRunCount} experiments automatically`}
            >
              ▶▶ Run
            </button>
          </div>
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <>
          <div className="section-divider" />
          <div className="section-label-row">
            <span className="section-label" style={{ marginBottom: 0 }}>History</span>
            <button
              className={`btn-log-copy ${copyState === 'copied' ? 'copied' : ''}`}
              onClick={copyLog}
              title="Copy full test log to clipboard"
            >
              {copyState === 'copied' ? '✓ Copied' : '⎘ Copy Log'}
            </button>
          </div>
          <div className="history-list">
            {[...history].reverse().slice(0, 8).map((entry, i) => {
              const isBest = bestEntry && entry.metrics.score === bestEntry.metrics.score
              return (
                <button
                  key={entry.testIndex}
                  className={`history-entry ${isBest ? 'best' : ''}`}
                  onClick={() => onGainsChange(entry.gains)}
                  title={`Test #${entry.testIndex + 1} — ${entry.steps.length} step${entry.steps.length !== 1 ? 's' : ''}. Click to restore gains.`}
                >
                  <span className="history-index">#{history.length - i}</span>
                  <div className="history-bar-wrap">
                    <div
                      className="history-bar"
                      style={{ width: `${Math.max(4, 100 - entry.metrics.score * 3)}%` }}
                    />
                  </div>
                  <span className="history-osc" style={{ color: oscColor(entry.metrics.oscillations) }}>
                    {entry.metrics.oscillations > 0 ? `~${entry.metrics.oscillations}` : '○'}
                  </span>
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
