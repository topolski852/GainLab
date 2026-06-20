import { useState } from 'react'
import { Gains, MechanismConfig, OptimizerEntry, PhaseInfo, AutoTuneConfig } from '../types'
import NumericInput from './NumericInput'
import { MOTORS } from '../physics/motors'
import { displayUnitLabel } from '../physics/simulator'

interface Props {
  gains: Gains
  mechanism: MechanismConfig
  nominalSetpoint: number
  testCount: number
  isRunning: boolean
  phaseInfo: PhaseInfo
  history: OptimizerEntry[]
  unitLabel: string
  currentPhase: number
  consecutiveHits: number
  phaseExpCount: number
  phaseExtCount: number
  phaseBestScore: number
  autoTuneRunning: boolean
  autoTuneDone: boolean
  autoTuneFailed: boolean
  autoTuneConfig: AutoTuneConfig
  manualRunning: boolean
  onStartAutoTune: () => void
  onStopAutoTune: () => void
  onAcceptTune: () => void
  onAutoTuneConfigChange: (cfg: AutoTuneConfig) => void
  onRestoreGains: (g: Gains) => void
}

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
  return `P${p}`
}

function phaseBadgeClass(p: number): string {
  if (p <= 1) return 'phase-badge phase-p1'
  return `phase-badge phase-p${Math.min(p, 7)}`
}

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
    const isBest   = bestEntry?.testIndex === testIndex
    const phaseStr = tunePhase > 1 ? ` [Phase ${tunePhase}]` : ''

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

function buildSimpleLog(history: OptimizerEntry[]): string {
  if (history.length === 0) return ''
  const bestEntry = history.reduce((b, e) => e.metrics.score < b.metrics.score ? e : b)
  const rows = history.map(e => {
    const isBest = e.testIndex === bestEntry.testIndex
    return `#${String(e.testIndex + 1).padStart(3)}  P${e.tunePhase}  ${e.metrics.score.toFixed(2)}${isBest ? '  ★' : ''}`
  })
  return [`Run   Ph  Score`, ...rows].join('\n')
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TunePanel({
  gains, mechanism, nominalSetpoint, testCount, isRunning,
  phaseInfo, history, unitLabel,
  currentPhase, consecutiveHits, phaseExpCount, phaseExtCount, phaseBestScore,
  autoTuneRunning, autoTuneDone, autoTuneFailed, autoTuneConfig,
  manualRunning,
  onStartAutoTune, onStopAutoTune, onAcceptTune,
  onAutoTuneConfigChange, onRestoreGains,
}: Props): JSX.Element {
  const [copyState, setCopyState]             = useState<'idle' | 'copied'>('idle')
  const [copySimpleState, setCopySimpleState] = useState<'idle' | 'copied'>('idle')
  const [advancedOpen, setAdvancedOpen]       = useState(false)

  function setCfgField(field: keyof AutoTuneConfig, val: number): void {
    onAutoTuneConfigChange({ ...autoTuneConfig, [field]: val })
  }

  function setPhaseRadius(idx: number, val: number): void {
    const next = [...autoTuneConfig.phaseRadii]
    next[idx] = val
    onAutoTuneConfigChange({ ...autoTuneConfig, phaseRadii: next })
  }

  function setPhaseThreshold(idx: number, val: number): void {
    const next = [...autoTuneConfig.phaseThresholds]
    next[idx] = val
    onAutoTuneConfigChange({ ...autoTuneConfig, phaseThresholds: next })
  }

  function copyLog(): void {
    if (history.length === 0) return
    const log = buildLog(history, mechanism, nominalSetpoint)
    navigator.clipboard.writeText(log).then(() => {
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 2000)
    }).catch(() => {})
  }

  function copySimpleLog(): void {
    if (history.length === 0) return
    navigator.clipboard.writeText(buildSimpleLog(history)).then(() => {
      setCopySimpleState('copied')
      setTimeout(() => setCopySimpleState('idle'), 2000)
    }).catch(() => {})
  }

  const bestEntry = history.length > 0
    ? history.reduce((b, e) => e.metrics.score < b.metrics.score ? e : b)
    : null

  const isStructured  = phaseInfo.phase === 'structured'
  const anyRunning    = autoTuneRunning || manualRunning
  const atTargetScore = consecutiveHits >= autoTuneConfig.consecutiveHits

  const phaseMax = currentPhase === 1
    ? autoTuneConfig.p1MaxExperiments
    : (currentPhase === 6 || currentPhase === 7)
      ? 1
      : autoTuneConfig.phaseMaxExperiments
  const phasePct = currentPhase > 0 ? Math.min(100, (phaseExpCount / phaseMax) * 100) : 0
  const hitsPct  = Math.min(100, (consecutiveHits / autoTuneConfig.consecutiveHits) * 100)

  // Suppress unused-variable warning — gains is only used in buildLog (via copyLog)
  void gains
  void unitLabel

  return (
    <div className="tune-panel">
      <div className="panel-title">
        Auto-Tune
        <span className="gains-subtitle">{testCount > 0 ? `${testCount} exp` : ''}</span>
      </div>

      {/* ── Phase status ─────────────────────────────────────────────────── */}
      <div className="tune-status-section">
        {currentPhase > 0 && (
          <div className="tune-status-header">
            <div className="tune-phase-badges">
              <span className={phaseBadgeClass(currentPhase)}>
                {phaseTag(currentPhase)}
              </span>
              {!(autoTuneDone || autoTuneFailed) && (
                <span className={`phase-badge ${isStructured ? 'phase-structured' : 'phase-ucb'}`}>
                  {phaseInfo.label}
                </span>
              )}
            </div>
          </div>
        )}

        {!(autoTuneDone || autoTuneFailed) && currentPhase > 0 && (
          <div className="phase-description">{phaseInfo.description}</div>
        )}

        {currentPhase > 0 && !(autoTuneDone || autoTuneFailed) && (
          <>
            <div className="tune-progress-row">
              <span className="tune-progress-label">
                {currentPhase === 1
                  ? 'Exploration'
                  : currentPhase === 6
                    ? 'Stress diagnostics'
                    : currentPhase === 7
                      ? 'Match benchmark'
                      : `Phase ${currentPhase} refinement`}
              </span>
              <span className="tune-progress-frac">{phaseExpCount} / {phaseMax}</span>
            </div>
            <div className="tune-progress-track">
              <div className="tune-progress-fill phase-fill" style={{ width: `${phasePct}%` }} />
            </div>

            <div className="tune-progress-row" style={{ marginTop: 6 }}>
              <span className="tune-progress-label">
                Score &lt; {autoTuneConfig.targetScore} consecutive
              </span>
              <span
                className="tune-progress-frac"
                style={atTargetScore ? { color: 'var(--success)' } : undefined}
              >
                {consecutiveHits} / {autoTuneConfig.consecutiveHits}
              </span>
            </div>
            <div className="tune-progress-track">
              <div
                className={`tune-progress-fill hits-fill ${atTargetScore ? 'hits-done' : ''}`}
                style={{ width: `${hitsPct}%` }}
              />
            </div>
          </>
        )}

        {bestEntry && (
          <div className="tune-best-score">
            Best:&nbsp;
            <span style={{ color: scoreColor(bestEntry.metrics.score) }}>
              {bestEntry.metrics.score.toFixed(2)}
            </span>
            {bestEntry.metrics.score < autoTuneConfig.targetScore && (
              <span style={{ color: 'var(--success)', marginLeft: 4 }}>✓ target</span>
            )}
          </div>
        )}

        {autoTuneDone && (
          <div className="tune-done-banner">
            {atTargetScore
              ? `✓ Target score ${autoTuneConfig.targetScore} reached`
              : '✓ All phases complete — using best gains'}
          </div>
        )}

        {autoTuneFailed && (
          <div className="tune-failed-banner">
            Phase {currentPhase} failed — best score{' '}
            {phaseBestScore < Infinity ? phaseBestScore.toFixed(2) : '—'} did not reach threshold{' '}
            {autoTuneConfig.phaseThresholds[Math.min(currentPhase - 1, autoTuneConfig.phaseThresholds.length - 1)] ?? '—'}{' '}
            after {autoTuneConfig.phaseExtensionMax} extra experiments
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
              : currentPhase === 6
                ? `Phase 6 — stress diagnostics…`
                : currentPhase === 7
                  ? `Phase 7 — match benchmark…`
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
            <NumericInput
              className="at-config-input"
              value={autoTuneConfig.targetScore}
              min={0.1}
              step={0.1}
              onChange={v => setCfgField('targetScore', v)}
            />
            <span className="at-config-unit">× {autoTuneConfig.consecutiveHits} in a row</span>
          </div>
          <div className="at-config-row">
            <label className="at-config-label">Phases</label>
            <NumericInput
              className="at-config-input at-config-input-sm"
              value={autoTuneConfig.numPhases}
              min={2}
              max={7}
              step={1}
              onChange={v => setCfgField('numPhases', Math.round(v))}
            />
            <span className="at-config-unit">
              {autoTuneConfig.numPhases <= 5
                ? `total (P1 + ${autoTuneConfig.numPhases - 1} fine-tune)`
                : autoTuneConfig.numPhases === 6
                  ? 'P1–5 + stress diagnostics'
                  : 'P1–5 + stress + benchmark'}
            </span>
          </div>
          <div className="at-config-row">
            <label className="at-config-label">Start phase</label>
            <NumericInput
              className="at-config-input at-config-input-sm"
              value={autoTuneConfig.startPhase}
              min={1}
              max={Math.max(1, autoTuneConfig.numPhases - 1)}
              step={1}
              onChange={v => setCfgField('startPhase', Math.round(v))}
            />
            <span className="at-config-unit">
              {autoTuneConfig.startPhase <= 1
                ? 'full run from exploration'
                : `skip P1–${autoTuneConfig.startPhase - 1}, use current gains`}
            </span>
          </div>

          <button className="at-advanced-toggle" onClick={() => setAdvancedOpen(o => !o)}>
            {advancedOpen ? '▾' : '▸'} Advanced
          </button>
          {advancedOpen && (
            <div className="at-advanced-grid">
              <div className="at-adv-row">
                <label>Consecutive hits</label>
                <NumericInput value={autoTuneConfig.consecutiveHits} min={1} max={20} step={1}
                  onChange={v => setCfgField('consecutiveHits', Math.round(v))} />
              </div>
              <div className="at-adv-row">
                <label>P1 max experiments</label>
                <NumericInput value={autoTuneConfig.p1MaxExperiments} min={7} max={100} step={1}
                  onChange={v => setCfgField('p1MaxExperiments', Math.round(v))} />
              </div>
              <div className="at-adv-row">
                <label>Phase N max experiments</label>
                <NumericInput value={autoTuneConfig.phaseMaxExperiments} min={5} max={60} step={1}
                  onChange={v => setCfgField('phaseMaxExperiments', Math.round(v))} />
              </div>
              {autoTuneConfig.numPhases >= 6 && (
                <div className="at-adv-row">
                  <label>Phase 6 retries</label>
                  <NumericInput value={autoTuneConfig.p6MaxRetries} min={0} max={5} step={1}
                    onChange={v => setCfgField('p6MaxRetries', Math.round(v))} />
                  <span className="at-adv-unit">max loops back</span>
                </div>
              )}
              {[2, 3, 4, 5].slice(0, Math.min(autoTuneConfig.numPhases - 1, 4)).map((pn, i) => (
                <div key={pn} className="at-adv-row">
                  <label>Phase {pn} radius</label>
                  <NumericInput
                    value={autoTuneConfig.phaseRadii[i] ?? 0.05}
                    min={0.01} max={0.5} step={0.01}
                    onChange={v => setPhaseRadius(i, v)}
                  />
                  <span className="at-adv-unit">
                    ± {((autoTuneConfig.phaseRadii[i] ?? 0.05) * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
              <div className="at-adv-row">
                <label>Fine-tune setpoints</label>
                <NumericInput value={autoTuneConfig.numSetpoints} min={2} max={16} step={1}
                  onChange={v => setCfgField('numSetpoints', Math.round(v))} />
              </div>
              <div className="at-adv-row">
                <label>Dwell time</label>
                <NumericInput value={autoTuneConfig.dwellS} min={0.3} max={5} step={0.1}
                  onChange={v => setCfgField('dwellS', v)} />
                <span className="at-adv-unit">s</span>
              </div>
              <div className="at-adv-row">
                <label>Randomization</label>
                <NumericInput value={autoTuneConfig.randomization} min={0} max={1} step={0.05}
                  onChange={v => setCfgField('randomization', v)} />
              </div>
              <div className="at-adv-row">
                <label>Phase extension max</label>
                <NumericInput value={autoTuneConfig.phaseExtensionMax} min={10} max={200} step={10}
                  onChange={v => setCfgField('phaseExtensionMax', Math.round(v))} />
                <span className="at-adv-unit">extra</span>
              </div>
              {[1, 2, 3, 4, 5].slice(0, Math.min(autoTuneConfig.numPhases - 1, 4)).map((pn, i) => (
                <div key={`thr${pn}`} className="at-adv-row">
                  <label>P{pn}→P{pn + 1} threshold</label>
                  <NumericInput
                    value={autoTuneConfig.phaseThresholds[i] ?? 30}
                    min={1} max={500} step={1}
                    onChange={v => setPhaseThreshold(i, Math.round(v))}
                  />
                  <span className="at-adv-unit">max</span>
                </div>
              ))}
            </div>
          )}

          <button
            className="btn btn-autotune"
            onClick={onStartAutoTune}
            disabled={isRunning || manualRunning}
          >
            {autoTuneDone || autoTuneFailed
              ? '↺ Re-run Auto-Tune'
              : currentPhase > 0
                ? '▶ Resume Auto-Tune'
                : '★ Auto-Tune'}
          </button>
        </div>
      )}

      {/* ── History ───────────────────────────────────────────────────────── */}
      {history.length > 0 && (
        <>
          <div className="section-divider" />
          <div className="section-label-row">
            <span className="section-label" style={{ marginBottom: 0 }}>History</span>
            <div className="log-copy-buttons">
              <button
                className={`btn-log-copy ${copySimpleState === 'copied' ? 'copied' : ''}`}
                onClick={copySimpleLog}
                title="Copy run # and score only"
              >
                {copySimpleState === 'copied' ? '✓ Copied' : '⎘ Simple'}
              </button>
              <button
                className={`btn-log-copy ${copyState === 'copied' ? 'copied' : ''}`}
                onClick={copyLog}
                title="Copy full test log to clipboard"
              >
                {copyState === 'copied' ? '✓ Copied' : '⎘ Full Log'}
              </button>
            </div>
          </div>
          <HistoryList history={history} bestEntry={bestEntry} onRestoreGains={onRestoreGains} />
        </>
      )}
    </div>
  )
}

// ─── History list with phase dividers ─────────────────────────────────────────

function HistoryList({
  history,
  bestEntry,
  onRestoreGains,
}: {
  history: OptimizerEntry[]
  bestEntry: OptimizerEntry | null
  onRestoreGains: (g: Gains) => void
}): JSX.Element {
  // Compute per-phase anchor (first run = previous phase best re-run) and best score.
  // History is ascending by testIndex so the first entry per phase is the anchor.
  const phaseStats = new Map<number, { anchorScore: number; bestScore: number }>()
  for (const entry of history) {
    const ph  = entry.tunePhase
    const cur = phaseStats.get(ph)
    if (!cur) {
      phaseStats.set(ph, { anchorScore: entry.metrics.score, bestScore: entry.metrics.score })
    } else {
      phaseStats.set(ph, { anchorScore: cur.anchorScore, bestScore: Math.min(cur.bestScore, entry.metrics.score) })
    }
  }

  const p7Entry  = history.find(e => e.tunePhase === 7)
  const reversed = [...history].reverse()
  let lastPhase  = -1
  const rows: JSX.Element[] = []

  for (let i = 0; i < reversed.length; i++) {
    const entry  = reversed[i]
    const isBest = bestEntry && entry.metrics.score === bestEntry.metrics.score
    const absIdx = history.length - i

    if (entry.tunePhase !== lastPhase) {
      lastPhase = entry.tunePhase
      const stats      = phaseStats.get(entry.tunePhase)
      const improved   = stats && stats.bestScore < stats.anchorScore
      const deltaPct   = improved
        ? (((stats!.bestScore - stats!.anchorScore) / stats!.anchorScore) * 100).toFixed(0)
        : null
      const phaseLabel = entry.tunePhase === 1
        ? 'Phase 1 — Exploration'
        : entry.tunePhase === 6
          ? 'Phase 6 — Stress Diagnostics'
          : entry.tunePhase === 7
            ? 'Phase 7 — Match Benchmark'
            : `Phase ${entry.tunePhase} — Fine-tune`

      rows.push(
        <div key={`divider-${entry.tunePhase}-${i}`} className="history-phase-divider">
          <span>{phaseLabel}</span>
          {improved && deltaPct && entry.tunePhase <= 5 && (
            <span className="history-phase-delta">
              {stats!.anchorScore.toFixed(2)} → {stats!.bestScore.toFixed(2)}
              <span className="delta-improve">&thinsp;{deltaPct}%</span>
            </span>
          )}
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

  return (
    <div className="history-outer">
      {p7Entry && (
        <div className="match-benchmark-banner">
          <span className="match-benchmark-label">Match Benchmark</span>
          <span className="match-benchmark-score">{p7Entry.metrics.score.toFixed(2)}</span>
          <span className="match-benchmark-star">★</span>
        </div>
      )}
      <div className="history-list">{rows}</div>
    </div>
  )
}
