import { useState } from 'react'
import { Gains, StepMetrics, MechanismConfig, OptimizerEntry, PhaseInfo, AutoTuneConfig } from '../types'
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
  unitLabel: string
  // Auto-tune
  currentPhase: number
  consecutiveHits: number
  phaseExpCount: number
  phaseExtCount: number
  phaseBestScore: number
  autoTuneRunning: boolean
  autoTuneDone: boolean
  autoTuneFailed: boolean
  autoTuneConfig: AutoTuneConfig
  // Manual run
  manualRunning: boolean
  manualRunProgress: { done: number; total: number }
  // Callbacks
  onGainsChange: (g: Gains) => void
  onRunTest: () => void
  onSuggest: () => void
  onExport: () => void
  onStartAutoTune: () => void
  onStopAutoTune: () => void
  onAcceptTune: () => void
  onStartManualRun: (n: number) => void
  onStopManualRun: () => void
  onAutoTuneConfigChange: (cfg: AutoTuneConfig) => void
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

function phaseTag(p: number): string {
  if (p <= 0) return '—'
  if (p === 1) return 'P1'
  return `P${p}`
}

function phaseBadgeClass(p: number): string {
  if (p <= 1) return 'phase-badge phase-p1'
  return `phase-badge phase-p${Math.min(p, 6)}`
}

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
    const { gains, metrics, segmentMetrics, steps, testIndex, tunePhase } = entry
    const isBest    = bestEntry?.testIndex === testIndex
    const phaseStr  = tunePhase > 1 ? ` [Phase ${tunePhase}]` : ''

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

    return [`Test #${testIndex + 1}${phaseStr}`, gainsLine, stepsLine, ...segLines, aggLine].join('\n')
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
  phaseInfo, history, unitLabel,
  currentPhase, consecutiveHits, phaseExpCount, phaseExtCount, phaseBestScore,
  autoTuneRunning, autoTuneDone, autoTuneFailed, autoTuneConfig,
  manualRunning, manualRunProgress,
  onGainsChange, onRunTest, onSuggest, onExport,
  onStartAutoTune, onStopAutoTune, onAcceptTune,
  onStartManualRun, onStopManualRun, onAutoTuneConfigChange
}: Props): JSX.Element {

  const [copyState, setCopyState]       = useState<'idle' | 'copied'>('idle')
  const [manualCount, setManualCount]   = useState(20)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const showKG     = mechanism.type === 'arm' || mechanism.type === 'elevator'
  const visibleGains = GAIN_DEFS.filter(g => g.key !== 'kG' || showKG)

  function setGain(key: keyof Gains, val: string): void {
    const n = parseFloat(val)
    if (!isNaN(n)) onGainsChange({ ...gains, [key]: n })
  }

  function setCfgField(field: keyof AutoTuneConfig, val: string): void {
    const n = parseFloat(val)
    if (!isNaN(n)) onAutoTuneConfigChange({ ...autoTuneConfig, [field]: n })
  }

  function setPhaseRadius(idx: number, val: string): void {
    const n = parseFloat(val)
    if (isNaN(n)) return
    const next = [...autoTuneConfig.phaseRadii]
    next[idx] = n
    onAutoTuneConfigChange({ ...autoTuneConfig, phaseRadii: next })
  }

  function setPhaseThreshold(idx: number, val: string): void {
    const n = parseFloat(val)
    if (isNaN(n)) return
    const next = [...autoTuneConfig.phaseThresholds]
    next[idx] = n
    onAutoTuneConfigChange({ ...autoTuneConfig, phaseThresholds: next })
  }

  const bestEntry = history.length > 0
    ? history.reduce((b, e) => e.metrics.score < b.metrics.score ? e : b)
    : null

  const isStructured     = phaseInfo.phase === 'structured'
  const anyRunning       = autoTuneRunning || manualRunning
  const atTargetScore    = consecutiveHits >= autoTuneConfig.consecutiveHits

  // Phase progress within current phase
  const phaseMax    = currentPhase === 1
    ? autoTuneConfig.p1MaxExperiments
    : currentPhase >= 6
      ? autoTuneConfig.p6MaxExperiments
      : autoTuneConfig.phaseMaxExperiments
  const phasePct    = currentPhase > 0 ? Math.min(100, (phaseExpCount / phaseMax) * 100) : 0
  const hitsPct     = Math.min(100, (consecutiveHits / autoTuneConfig.consecutiveHits) * 100)

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

      {/* ── Phase status ─────────────────────────────────────────────────── */}
      <div className="tune-status-section">
        <div className="tune-status-header">
          <div className="tune-phase-badges">
            {currentPhase > 0 && (
              <span className={phaseBadgeClass(currentPhase)}>
                {phaseTag(currentPhase)}
              </span>
            )}
            <span className={`phase-badge ${isStructured ? 'phase-structured' : 'phase-ucb'}`}>
              {phaseInfo.label}
            </span>
          </div>
          <span className="phase-exp-count">{testCount} exp</span>
        </div>
        <div className="phase-description">{phaseInfo.description}</div>

        {currentPhase > 0 && (
          <>
            {/* Phase progress */}
            <div className="tune-progress-row">
              <span className="tune-progress-label">
                {currentPhase === 1 ? 'Exploration' : `Phase ${currentPhase} refinement`}
              </span>
              <span className="tune-progress-frac">{phaseExpCount} / {phaseMax}</span>
            </div>
            <div className="tune-progress-track">
              <div className="tune-progress-fill phase-fill" style={{ width: `${phasePct}%` }} />
            </div>

            {/* Consecutive hits toward target */}
            <div className="tune-progress-row" style={{ marginTop: 6 }}>
              <span className="tune-progress-label">
                Score &lt; {autoTuneConfig.targetScore} consecutive
              </span>
              <span className="tune-progress-frac"
                style={atTargetScore ? { color: 'var(--success)' } : undefined}>
                {consecutiveHits} / {autoTuneConfig.consecutiveHits}
              </span>
            </div>
            <div className="tune-progress-track">
              <div
                className={`tune-progress-fill hits-fill ${atTargetScore ? 'hits-done' : ''}`}
                style={{ width: `${hitsPct}%` }}
              />
            </div>

            {bestEntry && (
              <div className="tune-best-score">
                Best: <span style={{ color: scoreColor(bestEntry.metrics.score) }}>
                  {bestEntry.metrics.score.toFixed(2)}
                </span>
                {bestEntry.metrics.score < autoTuneConfig.targetScore && (
                  <span style={{ color: 'var(--success)', marginLeft: 4 }}>✓ target</span>
                )}
              </div>
            )}
          </>
        )}

        {/* Done banner */}
        {autoTuneDone && (
          <div className="tune-done-banner">
            {atTargetScore
              ? `✓ Target score ${autoTuneConfig.targetScore} reached`
              : '✓ All phases complete — using best gains'}
          </div>
        )}

        {/* Failed banner */}
        {autoTuneFailed && (
          <div className="tune-failed-banner">
            Phase {currentPhase} failed — best score {phaseBestScore < Infinity ? phaseBestScore.toFixed(2) : '—'} did not reach threshold {autoTuneConfig.phaseThresholds[Math.min(currentPhase - 1, autoTuneConfig.phaseThresholds.length - 1)] ?? '—'} after {autoTuneConfig.phaseExtensionMax} extra experiments
          </div>
        )}
      </div>

      <div className="section-divider" />

      {/* ── Auto-Tune controls ────────────────────────────────────────────── */}
      {autoTuneRunning ? (
        <div className="at-running-controls">
          <div className="at-running-label">
            {currentPhase === 1
              ? `Phase 1 — exploring…`
              : phaseExtCount > 0
                ? `Phase ${currentPhase} — extending (${phaseExtCount}/${autoTuneConfig.phaseExtensionMax} extra)…`
                : `Phase ${currentPhase} — refining (±${((autoTuneConfig.phaseRadii[currentPhase - 2] ?? 0.05) * 100).toFixed(0)}%)…`}
          </div>
          <div className="at-running-buttons">
            <button className="btn btn-accept" onClick={onAcceptTune}>✓ Accept</button>
            <button className="btn btn-stop"   onClick={onStopAutoTune}>■ Stop</button>
          </div>
        </div>
      ) : (
        <div className="at-idle-controls">
          <div className="at-config-row">
            <label className="at-config-label">Target score</label>
            <input
              type="number"
              className="at-config-input"
              value={autoTuneConfig.targetScore}
              min={0.1}
              step={0.1}
              onChange={e => setCfgField('targetScore', e.target.value)}
            />
            <span className="at-config-unit">× {autoTuneConfig.consecutiveHits} in a row</span>
          </div>
          <div className="at-config-row">
            <label className="at-config-label">Phases</label>
            <input
              type="number"
              className="at-config-input at-config-input-sm"
              value={autoTuneConfig.numPhases}
              min={2}
              max={6}
              step={1}
              onChange={e => setCfgField('numPhases', e.target.value)}
            />
            <span className="at-config-unit">total (P1 + {autoTuneConfig.numPhases - 1} fine-tune)</span>
          </div>

          {/* Advanced config (collapsible) */}
          <button className="at-advanced-toggle" onClick={() => setAdvancedOpen(o => !o)}>
            {advancedOpen ? '▾' : '▸'} Advanced
          </button>
          {advancedOpen && (
            <div className="at-advanced-grid">
              <div className="at-adv-row">
                <label>Consecutive hits</label>
                <input type="number" value={autoTuneConfig.consecutiveHits} min={1} max={20} step={1}
                  onChange={e => setCfgField('consecutiveHits', e.target.value)} />
              </div>
              <div className="at-adv-row">
                <label>P1 max experiments</label>
                <input type="number" value={autoTuneConfig.p1MaxExperiments} min={7} max={100} step={1}
                  onChange={e => setCfgField('p1MaxExperiments', e.target.value)} />
              </div>
              <div className="at-adv-row">
                <label>Phase N max experiments</label>
                <input type="number" value={autoTuneConfig.phaseMaxExperiments} min={5} max={60} step={1}
                  onChange={e => setCfgField('phaseMaxExperiments', e.target.value)} />
              </div>
              {autoTuneConfig.numPhases >= 6 && (
                <div className="at-adv-row">
                  <label>Phase 6 max experiments</label>
                  <input type="number" value={autoTuneConfig.p6MaxExperiments} min={2} max={30} step={1}
                    onChange={e => setCfgField('p6MaxExperiments', e.target.value)} />
                </div>
              )}
              {[2, 3, 4, 5, 6].slice(0, autoTuneConfig.numPhases - 1).map((pn, i) => (
                <div key={pn} className="at-adv-row">
                  <label>Phase {pn} radius</label>
                  <input type="number" value={autoTuneConfig.phaseRadii[i] ?? 0.05}
                    min={0.01} max={0.5} step={0.01}
                    onChange={e => setPhaseRadius(i, e.target.value)} />
                  <span className="at-adv-unit">± {((autoTuneConfig.phaseRadii[i] ?? 0.05) * 100).toFixed(0)}%</span>
                </div>
              ))}
              <div className="at-adv-row">
                <label>Fine-tune setpoints</label>
                <input type="number" value={autoTuneConfig.numSetpoints} min={2} max={16} step={1}
                  onChange={e => setCfgField('numSetpoints', e.target.value)} />
              </div>
              <div className="at-adv-row">
                <label>Dwell time</label>
                <input type="number" value={autoTuneConfig.dwellS} min={0.3} max={5} step={0.1}
                  onChange={e => setCfgField('dwellS', e.target.value)} />
                <span className="at-adv-unit">s</span>
              </div>
              <div className="at-adv-row">
                <label>Randomization</label>
                <input type="number" value={autoTuneConfig.randomization} min={0} max={1} step={0.05}
                  onChange={e => setCfgField('randomization', e.target.value)} />
              </div>
              <div className="at-adv-row">
                <label>Phase extension max</label>
                <input type="number" value={autoTuneConfig.phaseExtensionMax} min={10} max={200} step={10}
                  onChange={e => setCfgField('phaseExtensionMax', e.target.value)} />
                <span className="at-adv-unit">extra experiments</span>
              </div>
              {[1, 2, 3, 4, 5].slice(0, Math.min(autoTuneConfig.numPhases - 1, 5)).map((pn, i) => (
                <div key={`thr${pn}`} className="at-adv-row">
                  <label>P{pn}→P{pn + 1} threshold</label>
                  <input type="number" value={autoTuneConfig.phaseThresholds[i] ?? 30} min={1} max={500} step={1}
                    onChange={e => setPhaseThreshold(i, e.target.value)} />
                  <span className="at-adv-unit">max score</span>
                </div>
              ))}
            </div>
          )}

          <button
            className="btn btn-autotune"
            onClick={onStartAutoTune}
            disabled={isRunning || manualRunning}
          >
            {autoTuneDone || autoTuneFailed ? '↺ Re-run Auto-Tune' : currentPhase > 0 ? '▶ Resume Auto-Tune' : '★ Auto-Tune'}
          </button>
        </div>
      )}

      <div className="section-divider" />

      {/* ── Results ──────────────────────────────────────────────────────── */}
      <div className="section-label">Results</div>
      {metrics ? (
        <div className="metrics-list">
          <MetricRow label="Rise Time" value={fmtTime(metrics.riseTimeS)} />
          <MetricRow label="Overshoot" value={fmtPct(metrics.overshootPct)}
            color={metrics.overshootPct > 10 ? 'var(--error)' : metrics.overshootPct > 5 ? 'var(--gold-bright)' : 'var(--success)'}
          />
          <MetricRow label="Settling"  value={fmtTime(metrics.settlingTimeS)} />
          <MetricRow label="SS Error"  value={metrics.steadyStateError.toFixed(4)} />
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

      {/* ── Manual controls ───────────────────────────────────────────────── */}
      <div className="manual-controls">
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
            disabled={testCount === 0}
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
            <input
              type="number"
              className="manual-run-input"
              value={manualCount}
              min={1}
              max={200}
              onChange={e => setManualCount(Math.max(1, parseInt(e.target.value) || 1))}
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

      {/* ── History ───────────────────────────────────────────────────────── */}
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
          <HistoryList history={history} bestEntry={bestEntry} onRestoreGains={onGainsChange} />
        </>
      )}
    </div>
  )
}

// ─── History list with phase dividers ─────────────────────────────────────────

function HistoryList({
  history,
  bestEntry,
  onRestoreGains
}: {
  history: OptimizerEntry[]
  bestEntry: OptimizerEntry | null
  onRestoreGains: (g: Gains) => void
}): JSX.Element {
  const recent = [...history].reverse().slice(0, 10)

  let lastPhase = -1
  const rows: JSX.Element[] = []

  for (let i = 0; i < recent.length; i++) {
    const entry   = recent[i]
    const isBest  = bestEntry && entry.metrics.score === bestEntry.metrics.score
    const absIdx  = history.length - i

    // Insert phase divider when phase changes
    if (entry.tunePhase !== lastPhase) {
      lastPhase = entry.tunePhase
      rows.push(
        <div key={`divider-${entry.tunePhase}-${i}`} className="history-phase-divider">
          {entry.tunePhase === 1 ? 'Phase 1 — Exploration' : `Phase ${entry.tunePhase} — Fine-tune`}
        </div>
      )
    }

    rows.push(
      <button
        key={entry.testIndex}
        className={`history-entry ${isBest ? 'best' : ''}`}
        onClick={() => onRestoreGains(entry.gains)}
        title={`Test #${entry.testIndex + 1} — ${entry.steps.length} step${entry.steps.length !== 1 ? 's' : ''}. Click to restore gains.`}
      >
        <span className="history-index">#{absIdx}</span>
        <span className={`history-phase-tag ${entry.tunePhase > 1 ? 'fine-tune' : ''}`}>
          {phaseTag(entry.tunePhase)}
        </span>
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
  }

  return <div className="history-list">{rows}</div>
}

function MetricRow({ label, value, color }: { label: string; value: string; color?: string }): JSX.Element {
  return (
    <div className="metric-list-row">
      <span className="metric-list-label">{label}</span>
      <span className="metric-list-value" style={color ? { color } : undefined}>{value}</span>
    </div>
  )
}
