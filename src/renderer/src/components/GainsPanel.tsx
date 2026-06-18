import { useState } from 'react'
import { Gains, StepMetrics, MechanismConfig } from '../types'
import NumericInput from './NumericInput'
import { MOTORS } from '../physics/motors'

interface Props {
  gains: Gains
  metrics: StepMetrics | null
  mechanism: MechanismConfig
  setpointDisplay: number
  unitLabel: string
  isRunning: boolean
  autoTuneRunning: boolean
  manualRunning: boolean
  manualRunProgress: { done: number; total: number }
  onGainsChange: (g: Gains) => void
  onSetpointChange: (v: number) => void
  onRunTest: () => void
  onSuggest: () => void
  onExport: () => void
  onStartManualRun: (n: number) => void
  onStopManualRun: () => void
  onOpenConfig: () => void
}

const GAIN_DEFS: { key: keyof Gains; label: string; unit: string; step: number; min: number }[] = [
  { key: 'kP', label: 'kP', unit: 'V/err',    step: 0.001,  min: 0 },
  { key: 'kI', label: 'kI', unit: 'V/err·s',  step: 0.0001, min: 0 },
  { key: 'kD', label: 'kD', unit: 'V·s/err',  step: 0.001,  min: 0 },
  { key: 'kS', label: 'kS', unit: 'V',        step: 0.01,   min: 0 },
  { key: 'kV', label: 'kV', unit: 'V·s/rot',  step: 0.001,  min: 0 },
  { key: 'kA', label: 'kA', unit: 'V·s²/rot', step: 0.001,  min: 0 },
  { key: 'kG', label: 'kG', unit: 'V',        step: 0.01,   min: 0 },
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

function mechIcon(type: MechanismConfig['type']): string {
  if (type === 'flywheel') return '◎'
  if (type === 'arm')      return '⌒'
  return '↕'
}

function mechIconColor(type: MechanismConfig['type']): string {
  if (type === 'flywheel') return 'var(--blue-bright)'
  if (type === 'arm')      return '#f0a529'
  return 'var(--success)'
}

export default function GainsPanel({
  gains, metrics, mechanism, setpointDisplay, unitLabel,
  isRunning, autoTuneRunning, manualRunning, manualRunProgress,
  onGainsChange, onSetpointChange, onRunTest, onSuggest, onExport,
  onStartManualRun, onStopManualRun, onOpenConfig,
}: Props): JSX.Element {
  const [manualCount, setManualCount] = useState(20)

  const isPositionControl = mechanism.type === 'arm' || mechanism.type === 'elevator'
  const visibleGains = GAIN_DEFS.filter(g => {
    if (g.key === 'kG') return isPositionControl
    if (g.key === 'kS' || g.key === 'kV' || g.key === 'kA') return !isPositionControl
    return true
  })

  function setGain(key: keyof Gains, val: number): void {
    onGainsChange({ ...gains, [key]: val })
  }

  const anyRunning  = isRunning || autoTuneRunning || manualRunning
  const motor       = MOTORS[mechanism.motorType]
  const motorLabel  = motor ? `${mechanism.numMotors > 1 ? `${mechanism.numMotors}× ` : ''}${motor.name}` : mechanism.motorType
  const gearLabel   = `${mechanism.gearRatio % 1 === 0 ? mechanism.gearRatio : mechanism.gearRatio.toFixed(2)}:1`
  const mechLabel   = mechanism.type.charAt(0).toUpperCase() + mechanism.type.slice(1)

  const setpointStep = mechanism.type === 'flywheel' ? 100 : mechanism.type === 'arm' ? 5 : 0.1

  return (
    <div className="bottom-panel">
      {/* ── Motor strip ────────────────────────────────────────────────────── */}
      <div className="motor-strip">
        <div className="motor-strip-info">
          <span className="motor-strip-icon" style={{ color: mechIconColor(mechanism.type) }}>
            {mechIcon(mechanism.type)}
          </span>
          <span className="motor-strip-type">{mechLabel}</span>
          <span className="motor-strip-dot">·</span>
          <span>{gearLabel}</span>
          <span className="motor-strip-dot">·</span>
          <span>{motorLabel}</span>
        </div>

        <div className="motor-strip-setpoint">
          <NumericInput
            className="input-num motor-strip-sp-input"
            value={setpointDisplay}
            step={setpointStep}
            onChange={onSetpointChange}
          />
          <span className="motor-strip-setpoint-unit">{unitLabel}</span>
        </div>

        <button className="motor-strip-configure" onClick={onOpenConfig}>
          Configure ↗
        </button>
      </div>

      {/* ── Main body: gains + metrics/controls ────────────────────────────── */}
      <div className="bottom-body">
        {/* Left: gains */}
        <div className="bottom-gains">
          <div className="gains-grid">
            {visibleGains.map(def => (
              <div key={def.key} className="gain-row">
                <label className="gain-label">{def.label}</label>
                <NumericInput
                  className="gain-input"
                  value={gains[def.key]}
                  step={def.step}
                  min={def.min}
                  onChange={v => setGain(def.key, v)}
                />
                <span className="gain-unit">{def.unit}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right: metrics + controls */}
        <div className="bottom-right">
          {/* Metrics */}
          {metrics ? (
            <div className="bottom-metrics">
              <div className="bottom-metrics-grid">
                <MetricCell label="Rise" value={fmtTime(metrics.riseTimeS)} />
                <MetricCell
                  label="Overshoot"
                  value={`${metrics.overshootPct.toFixed(1)}%`}
                  color={metrics.overshootPct > 10 ? 'var(--error)' : metrics.overshootPct > 5 ? 'var(--gold-bright)' : 'var(--success)'}
                />
                <MetricCell label="Settling" value={fmtTime(metrics.settlingTimeS)} />
                <MetricCell label="SS Error" value={metrics.steadyStateError.toFixed(4)} />
                <MetricCell
                  label="Osc"
                  value={metrics.oscillations === 0 ? 'None' : `${metrics.oscillations}`}
                  color={oscColor(metrics.oscillations)}
                />
                <div className="bottom-score-cell">
                  <span className="bottom-score-label">Score</span>
                  <span className="bottom-score-value" style={{ color: scoreColor(metrics.score) }}>
                    {metrics.score.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="bottom-metrics-empty">No results yet</div>
          )}

          {/* Manual controls */}
          <div className="bottom-controls">
            <div className="manual-top-row">
              <button
                className={`btn btn-primary btn-sm ${isRunning ? 'loading' : ''}`}
                onClick={onRunTest}
                disabled={anyRunning}
              >
                {isRunning ? <><span className="spinner" /> Running…</> : '▶ Run 1'}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={onSuggest}
                disabled={anyRunning}
                title="Suggest gains via optimizer"
              >
                ◆ Suggest
              </button>
              <button
                className="btn btn-export btn-sm"
                onClick={onExport}
                disabled={metrics === null}
              >
                ↗ Export
              </button>
            </div>

            {manualRunning ? (
              <div className="manual-run-active">
                <span className="auto-run-spinner" />
                <span>Experiment {manualRunProgress.done + 1} of {manualRunProgress.total}</span>
                <button className="btn btn-stop btn-sm" onClick={onStopManualRun}>■</button>
              </div>
            ) : (
              <div className="manual-run-row">
                <NumericInput
                  className="manual-run-input"
                  value={manualCount}
                  min={1}
                  max={200}
                  onChange={v => setManualCount(Math.max(1, Math.round(v)))}
                  title="Experiments to run"
                />
                <span className="manual-run-unit">experiments</span>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => onStartManualRun(manualCount)}
                  disabled={isRunning || autoTuneRunning}
                >
                  ▶▶ Run N
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function MetricCell({ label, value, color }: { label: string; value: string; color?: string }): JSX.Element {
  return (
    <div className="bottom-metric-cell">
      <span className="bottom-metric-label">{label}</span>
      <span className="bottom-metric-value" style={color ? { color } : undefined}>{value}</span>
    </div>
  )
}
