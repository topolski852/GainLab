import { useState, useRef, useCallback, useEffect } from 'react'
import {
  MechanismConfig, Gains, AppState, StepResponsePoint, OptimizerEntry,
  ConnectionStatus, PhaseInfo, AutoTuneConfig, TestStep, defaultAutoTuneConfig,
  Project, MotorProfile, defaultMotorProfile, defaultProject
} from './types'
import {
  runMultiStepSimulation, runSimulation, calculateBaselineGains,
  displayUnitLabel, defaultSetpoint, getTestSequence, generatePhaseSequence
} from './physics/simulator'
import { BayesianOptimizer, defaultBounds } from './optimizer/bayesian'
import { NT4Client, nt4URL } from './nt4/client'
import MechanismPanel from './components/MechanismPanel'
import StepGraph from './components/StepGraph'
import GainsPanel from './components/GainsPanel'
import StatusBar from './components/StatusBar'
import Launcher from './components/Launcher'
import ProjectSidebar from './components/ProjectSidebar'
import MotorConfigModal from './components/MotorConfigModal'

const DEFAULT_MECHANISM: MechanismConfig = {
  type: 'flywheel',
  motorType: 'falcon500',
  numMotors: 1,
  gearRatio: 1,
  massKg: 0.5,
  radiusM: 0.1,
  lengthM: 0.5,
  startAngleDeg: 0,
  spoolRadiusM: 0.0254,
  startHeightM: 0
}

export default function App(): JSX.Element {
  const [mechanism, setMechanism] = useState<MechanismConfig>(DEFAULT_MECHANISM)
  const [gains, setGains] = useState<Gains>(() => calculateBaselineGains(DEFAULT_MECHANISM))
  const [setpointDisplay, setSetpointDisplay] = useState<number>(defaultSetpoint(DEFAULT_MECHANISM))
  const [stepData, setStepData] = useState<StepResponsePoint[]>([])
  const [segmentBoundaries, setSegmentBoundaries] = useState<number[]>([])
  const [metrics, setMetrics] = useState<AppState['metrics']>(null)
  const [history, setHistory] = useState<OptimizerEntry[]>([])
  const [testCount, setTestCount] = useState(0)
  const [isRunning, setIsRunning] = useState(false)
  const [connectionMode, setConnectionMode] = useState<'sim' | 'live'>('sim')
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [teamNumber, setTeamNumber] = useState('1507')

  // ── Auto-Tune state ─────────────────────────────────────────────────────────
  const [autoTuneRunning, setAutoTuneRunning] = useState(false)
  const [autoTuneDone, setAutoTuneDone] = useState(false)
  const [autoTuneFailed, setAutoTuneFailed] = useState(false)
  const [currentPhase, setCurrentPhase] = useState(0)        // 0=idle,1=P1,2+=fine-tune
  const [consecutiveHits, setConsecutiveHits] = useState(0)  // consecutive < targetScore
  const [phaseExpCount, setPhaseExpCount] = useState(0)      // experiments in current phase
  const [phaseExtCount, setPhaseExtCount] = useState(0)      // extra experiments in extension mode
  const [phaseBestScore, setPhaseBestScore] = useState(Infinity) // best score within current phase
  const [autoTuneConfig, setAutoTuneConfig] = useState<AutoTuneConfig>(
    () => defaultAutoTuneConfig(defaultSetpoint(DEFAULT_MECHANISM))
  )

  // ── Manual run state ────────────────────────────────────────────────────────
  const [manualRunning, setManualRunning] = useState(false)
  const [manualRunProgress, setManualRunProgress] = useState({ done: 0, total: 0 })

  // ── Project state ────────────────────────────────────────────────────────────
  const [appView, setAppView]               = useState<'launcher' | 'project'>('launcher')
  const [activeProject, setActiveProject]   = useState<Project | null>(null)
  const [activeProjectPath, setActiveProjectPath] = useState<string | null>(null)
  const [activeMotorId, setActiveMotorId]   = useState<string | null>(null)
  const [isSaving, setIsSaving]             = useState(false)
  const [showMotorConfig, setShowMotorConfig] = useState(false)
  const [configMotorId, setConfigMotorId]   = useState<string | null>(null)
  const [motorConfigDraft, setMotorConfigDraft] = useState<MotorProfile | null>(null)

  // ── Optimizer refs ──────────────────────────────────────────────────────────
  const optimizerRef      = useRef<BayesianOptimizer | null>(null)
  const fineTuneOptRef    = useRef<BayesianOptimizer | null>(null)  // current fine-tune phase
  const nt4Ref            = useRef<NT4Client | null>(null)
  const liveBufferRef     = useRef<StepResponsePoint[]>([])
  const liveStartTimeRef  = useRef<number>(0)
  const liveTestActiveRef = useRef(false)

  // Mutable refs for values that must be readable inside setTimeout callbacks
  // without causing runSim to be recreated (avoids stale closure issues).
  const currentPhaseRef      = useRef(0)
  const consecutiveHitsRef   = useRef(0)
  const phaseExpCountRef     = useRef(0)
  const phaseExtCountRef     = useRef(0)
  const phaseBestScoreRef    = useRef(Infinity)
  const autoTuneConfigRef    = useRef<AutoTuneConfig>(autoTuneConfig)
  const autoTuneActiveRef    = useRef(false)
  const fineTuneSeqRef       = useRef<TestStep[]>([])
  // Stable history array kept in sync synchronously within runSim (not via setState).
  const allEntriesRef        = useRef<OptimizerEntry[]>([])

  // Manual run refs
  const manualActiveRef  = useRef(false)
  const manualDoneRef    = useRef(0)
  const manualTotalRef   = useRef(0)

  // Forward ref to latest runSim closure so auto-run always calls the latest version.
  const runSimRef = useRef<() => void>(() => {})

  // Keep config ref in sync
  useEffect(() => { autoTuneConfigRef.current = autoTuneConfig }, [autoTuneConfig])

  // ── Reset on mechanism change ───────────────────────────────────────────────
  useEffect(() => {
    optimizerRef.current   = new BayesianOptimizer(defaultBounds(mechanism.type), mechanism.type)
    fineTuneOptRef.current = null
    fineTuneSeqRef.current = []
    allEntriesRef.current  = []
    currentPhaseRef.current      = 0
    consecutiveHitsRef.current   = 0
    phaseExpCountRef.current     = 0
    phaseExtCountRef.current     = 0
    phaseBestScoreRef.current    = Infinity
    autoTuneActiveRef.current    = false
    manualActiveRef.current      = false
    setCurrentPhase(0)
    setConsecutiveHits(0)
    setPhaseExpCount(0)
    setPhaseExtCount(0)
    setPhaseBestScore(Infinity)
    setAutoTuneRunning(false)
    setAutoTuneDone(false)
    setAutoTuneFailed(false)
    setManualRunning(false)
    setHistory([])
    setTestCount(0)
    setStepData([])
    setSegmentBoundaries([])
    setMetrics(null)
    setGains(calculateBaselineGains(mechanism))
    const sp = defaultSetpoint(mechanism)
    setSetpointDisplay(sp)
    setAutoTuneConfig(defaultAutoTuneConfig(sp))
  }, [mechanism.type, mechanism.motorType, mechanism.numMotors, mechanism.gearRatio,
      mechanism.massKg, mechanism.radiusM, mechanism.lengthM, mechanism.spoolRadiusM])

  // ── Simulation core ─────────────────────────────────────────────────────────

  const runSim = useCallback(() => {
    if (isRunning) return
    setIsRunning(true)

    setTimeout(() => {
      const phase        = currentPhaseRef.current
      const isFineTune   = phase >= 2
      const activeOpt    = isFineTune ? fineTuneOptRef.current : optimizerRef.current
      const steps        = isFineTune && fineTuneSeqRef.current.length > 0
        ? fineTuneSeqRef.current
        : getTestSequence(mechanism.type, setpointDisplay, testCount)
      const result       = runMultiStepSimulation(mechanism, gains, steps)

      setStepData(result.points)
      setSegmentBoundaries(result.segmentBoundaries)
      setMetrics(result.aggregateMetrics)

      const entry: OptimizerEntry = {
        gains:          { ...gains },
        metrics:        result.aggregateMetrics,
        segmentMetrics: result.segmentMetrics,
        testIndex:      testCount,
        steps,
        tunePhase:      Math.max(1, phase),
      }
      allEntriesRef.current = [...allEntriesRef.current, entry]
      setHistory(allEntriesRef.current)
      setTestCount(prev => prev + 1)
      activeOpt?.observe(entry)

      // Consecutive-hits tracking and per-phase best score
      const score = result.aggregateMetrics.score
      const cfg   = autoTuneConfigRef.current
      if (score < cfg.targetScore) {
        consecutiveHitsRef.current += 1
      } else {
        consecutiveHitsRef.current = 0
      }
      setConsecutiveHits(consecutiveHitsRef.current)
      if (score < phaseBestScoreRef.current) {
        phaseBestScoreRef.current = score
        setPhaseBestScore(score)
      }

      // Auto-suggest next gains for the next experiment
      if (activeOpt) {
        const bl = calculateBaselineGains(mechanism)
        setGains(activeOpt.suggest({ kV: bl.kV, kG: bl.kG, kA: bl.kA }))
      }

      setIsRunning(false)

      // ── Auto-Tune continuation ────────────────────────────────────────────
      if (autoTuneActiveRef.current) {
        const onLastPhase = phase >= cfg.numPhases
        const maxExp = phase === 1 ? cfg.p1MaxExperiments : phase >= 6 ? cfg.p6MaxExperiments : cfg.phaseMaxExperiments
        // phaseThresholds[0] = p1→p2 threshold, [1] = p2→p3, etc.
        const thresholdIdx = Math.min(phase - 1, cfg.phaseThresholds.length - 1)
        const phaseThreshold = cfg.phaseThresholds[thresholdIdx] ?? Infinity

        // Advance to the next phase (shared by consecutive-hits fast-forward and maxExp trigger).
        function advancePhase(): void {
          const nextPhase = phase + 1
          const hist      = allEntriesRef.current
          const bestEntry = hist.reduce((b, e) => e.metrics.score < b.metrics.score ? e : b)
          const p1Bounds  = optimizerRef.current?.currentBounds ?? defaultBounds(mechanism.type)
          fineTuneSeqRef.current  = generatePhaseSequence(mechanism.type, setpointDisplay, nextPhase, cfg.randomization)
          fineTuneOptRef.current  = BayesianOptimizer.createNextPhase(nextPhase, hist, bestEntry.gains, p1Bounds, mechanism.type, cfg)
          currentPhaseRef.current = nextPhase
          setCurrentPhase(nextPhase)
          consecutiveHitsRef.current = 0
          setConsecutiveHits(0)
          phaseExpCountRef.current = 0
          setPhaseExpCount(0)
          phaseExtCountRef.current = 0
          setPhaseExtCount(0)
          phaseBestScoreRef.current = Infinity
          setPhaseBestScore(Infinity)
        }

        // Consecutive hits: fast-forward to next phase, or finish if on the last phase.
        if (consecutiveHitsRef.current >= cfg.consecutiveHits) {
          if (onLastPhase) {
            autoTuneActiveRef.current = false
            setAutoTuneRunning(false)
            setAutoTuneDone(true)
            return
          }
          advancePhase()
        }

        // Phase experiment count
        phaseExpCountRef.current += 1
        setPhaseExpCount(phaseExpCountRef.current)

        // Max experiments reached: check phase threshold before advancing.
        if (phaseExpCountRef.current >= maxExp && !onLastPhase) {
          if (phaseBestScoreRef.current <= phaseThreshold) {
            // Threshold cleared — advance normally.
            advancePhase()
          } else {
            // Threshold not met — enter/continue extension mode.
            phaseExtCountRef.current += 1
            setPhaseExtCount(phaseExtCountRef.current)
            if (phaseExtCountRef.current >= cfg.phaseExtensionMax) {
              // Extension exhausted without meeting threshold — fail.
              autoTuneActiveRef.current = false
              setAutoTuneRunning(false)
              setAutoTuneFailed(true)
              return
            }
            // Otherwise keep running extra experiments (no phase advance yet).
          }
        }

        // Last phase: advance (finish) when cap hit, regardless of threshold.
        if (phaseExpCountRef.current >= maxExp && onLastPhase) {
          autoTuneActiveRef.current = false
          setAutoTuneRunning(false)
          setAutoTuneDone(true)
          return
        }

        setTimeout(() => { if (autoTuneActiveRef.current) runSimRef.current() }, 80)
        return
      }

      // ── Manual run continuation ───────────────────────────────────────────
      if (manualActiveRef.current) {
        manualDoneRef.current += 1
        const done  = manualDoneRef.current
        const total = manualTotalRef.current
        setManualRunProgress({ done, total })
        if (done < total) {
          setTimeout(() => { if (manualActiveRef.current) runSimRef.current() }, 80)
        } else {
          manualActiveRef.current = false
          setManualRunning(false)
        }
      }
    }, 0)
  }, [mechanism, gains, setpointDisplay, isRunning, testCount])

  useEffect(() => { runSimRef.current = runSim }, [runSim])

  // ── Auto-Tune controls ──────────────────────────────────────────────────────

  const startAutoTune = useCallback(() => {
    if (isRunning || autoTuneActiveRef.current) return

    // If re-starting after done/failed or from idle: full reset
    if (currentPhaseRef.current === 0 || autoTuneDone || autoTuneFailed) {
      optimizerRef.current   = new BayesianOptimizer(defaultBounds(mechanism.type), mechanism.type)
      fineTuneOptRef.current = null
      fineTuneSeqRef.current = []
      allEntriesRef.current  = []
      currentPhaseRef.current    = 1
      consecutiveHitsRef.current = 0
      phaseExpCountRef.current   = 0
      phaseExtCountRef.current   = 0
      phaseBestScoreRef.current  = Infinity
      setCurrentPhase(1)
      setConsecutiveHits(0)
      setPhaseExpCount(0)
      setPhaseExtCount(0)
      setPhaseBestScore(Infinity)
      setAutoTuneDone(false)
      setAutoTuneFailed(false)
      setHistory([])
      setTestCount(0)
      setMetrics(null)
      setStepData([])
      setSegmentBoundaries([])
      setGains(calculateBaselineGains(mechanism))
    } else {
      // Resume from current phase (e.g., after Stop)
      if (currentPhaseRef.current === 0) {
        currentPhaseRef.current = 1
        setCurrentPhase(1)
      }
    }

    autoTuneActiveRef.current = true
    setAutoTuneRunning(true)
    setTimeout(() => runSimRef.current(), 0)
  }, [isRunning, mechanism, autoTuneDone, autoTuneFailed])

  const stopAutoTune = useCallback(() => {
    autoTuneActiveRef.current = false
    setAutoTuneRunning(false)
  }, [])

  const acceptTune = useCallback(() => {
    autoTuneActiveRef.current = false
    setAutoTuneRunning(false)
    setAutoTuneDone(true)
    // Snap gains to the best found so far
    const best = allEntriesRef.current.reduce<OptimizerEntry | null>(
      (b, e) => !b || e.metrics.score < b.metrics.score ? e : b, null
    )
    if (best) setGains(best.gains)
  }, [])

  // ── Manual run controls ─────────────────────────────────────────────────────

  const startManualRun = useCallback((n: number) => {
    if (isRunning || n < 1 || autoTuneActiveRef.current) return
    if (currentPhaseRef.current === 0) {
      currentPhaseRef.current = 1
      setCurrentPhase(1)
    }
    manualDoneRef.current   = 0
    manualTotalRef.current  = n
    manualActiveRef.current = true
    setManualRunning(true)
    setManualRunProgress({ done: 0, total: n })
    setTimeout(() => runSimRef.current(), 0)
  }, [isRunning])

  const stopManualRun = useCallback(() => {
    manualActiveRef.current = false
    setManualRunning(false)
  }, [])

  // ── Bayesian suggest ────────────────────────────────────────────────────────

  const suggestGains = useCallback(() => {
    const activeOpt = currentPhaseRef.current >= 2
      ? fineTuneOptRef.current
      : optimizerRef.current
    if (!activeOpt) return
    const baseline = calculateBaselineGains(mechanism)
    setGains(activeOpt.suggest({ kV: baseline.kV, kG: baseline.kG, kA: baseline.kA }))
  }, [mechanism])

  // ── NT4 live mode ───────────────────────────────────────────────────────────

  const connectNT4 = useCallback(() => {
    if (nt4Ref.current) nt4Ref.current.disconnect()

    const url    = nt4URL(teamNumber)
    const prefix = '/gainlab'
    const client = new NT4Client(
      url,
      (topic, _timestampUs, value) => {
        if (!liveTestActiveRef.current) return
        if (topic === `${prefix}/actual` && typeof value === 'number') {
          const elapsed = (performance.now() - liveStartTimeRef.current) / 1000
          liveBufferRef.current.push({
            time:     parseFloat(elapsed.toFixed(3)),
            setpoint: setpointDisplay,
            actual:   parseFloat((value as number).toFixed(4))
          })
          setStepData([...liveBufferRef.current])
          if (elapsed >= 2.0) endLiveTest()
        }
      },
      (status) => setConnectionStatus(status)
    )
    client.subscribe(`${prefix}/actual`)
    client.publish(`${prefix}/setpoint`)
    client.publish(`${prefix}/enabled`)
    client.connect()
    nt4Ref.current = client
    setConnectionMode('live')
  }, [teamNumber, setpointDisplay])

  const disconnectNT4 = useCallback(() => {
    nt4Ref.current?.disconnect()
    nt4Ref.current = null
    setConnectionMode('sim')
    setConnectionStatus('disconnected')
  }, [])

  const startLiveTest = useCallback(() => {
    if (!nt4Ref.current?.isConnected() || isRunning) return
    liveBufferRef.current = []
    liveStartTimeRef.current = performance.now()
    liveTestActiveRef.current = true
    setIsRunning(true)
    setStepData([])
    setSegmentBoundaries([])
    const prefix = '/gainlab'
    nt4Ref.current.publishValue(`${prefix}/setpoint`, setpointDisplay)
    nt4Ref.current.publishValue(`${prefix}/enabled`, 1)
  }, [isRunning, setpointDisplay])

  function endLiveTest(): void {
    liveTestActiveRef.current = false
    nt4Ref.current?.publishValue('/gainlab/enabled', 0)
    const pts = liveBufferRef.current
    if (pts.length > 0) {
      const { metrics: m } = runSimulation(mechanism, gains, setpointDisplay, 0)
      setMetrics(m)
      const entry: OptimizerEntry = {
        gains:          { ...gains },
        metrics:        m,
        segmentMetrics: [],
        testIndex:      testCount,
        steps:          [{ setpointDisplay, durationS: 2.0 }],
        tunePhase:      1,
      }
      allEntriesRef.current = [...allEntriesRef.current, entry]
      setHistory(allEntriesRef.current)
      setTestCount(prev => prev + 1)
      optimizerRef.current?.observe(entry)
    }
    setIsRunning(false)
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  const exportJava = useCallback(() => {
    // Use the best-scoring gains from the optimizer history if available;
    // fall back to current gains for manual / non-auto-tune sessions.
    const bestEntry = allEntriesRef.current.length > 0
      ? allEntriesRef.current.reduce((b, e) => e.metrics.score < b.metrics.score ? e : b)
      : null
    const exportGains = bestEntry?.gains ?? gains
    const mechLabel = mechanism.type.charAt(0).toUpperCase() + mechanism.type.slice(1)
    const snippet = [
      `// GainLab — ${mechLabel} gains (CTRE Phoenix 6)`,
      `// Motor: ${mechanism.numMotors}× ${mechanism.motorType}, Gear ratio: ${mechanism.gearRatio}`,
      `// Tests run: ${testCount}${bestEntry ? `  |  Best score: ${bestEntry.metrics.score.toFixed(2)}` : ''}`,
      ``,
      `TalonFXConfiguration config = new TalonFXConfiguration();`,
      `config.Slot0.kP = ${exportGains.kP.toFixed(4)};`,
      `config.Slot0.kI = ${exportGains.kI.toFixed(4)};`,
      `config.Slot0.kD = ${exportGains.kD.toFixed(4)};`,
      `config.Slot0.kS = ${exportGains.kS.toFixed(4)};`,
      `config.Slot0.kV = ${exportGains.kV.toFixed(4)};`,
      `config.Slot0.kA = ${exportGains.kA.toFixed(4)};`,
      `config.Slot0.kG = ${exportGains.kG.toFixed(4)};`,
      `motor.getConfigurator().apply(config);`
    ].join('\n')
    if (window.api) {
      window.api.saveSession(JSON.stringify({ gains: exportGains, mechanism, snippet, testCount }))
    } else {
      navigator.clipboard.writeText(snippet).catch(() => {})
    }
  }, [gains, mechanism, testCount])

  // ── Project management ──────────────────────────────────────────────────────

  function resetTunerState(): void {
    optimizerRef.current      = null
    fineTuneOptRef.current    = null
    fineTuneSeqRef.current    = []
    allEntriesRef.current     = []
    currentPhaseRef.current   = 0
    consecutiveHitsRef.current = 0
    phaseExpCountRef.current  = 0
    phaseExtCountRef.current  = 0
    phaseBestScoreRef.current = Infinity
    autoTuneActiveRef.current = false
    manualActiveRef.current   = false
    setCurrentPhase(0)
    setConsecutiveHits(0)
    setPhaseExpCount(0)
    setPhaseExtCount(0)
    setPhaseBestScore(Infinity)
    setAutoTuneRunning(false)
    setAutoTuneDone(false)
    setAutoTuneFailed(false)
    setManualRunning(false)
    setHistory([])
    setTestCount(0)
    setStepData([])
    setSegmentBoundaries([])
    setMetrics(null)
  }

  function loadMotor(motor: MotorProfile): void {
    resetTunerState()
    setMechanism(motor.mechanism)
    setGains(motor.gains)
    setSetpointDisplay(motor.nominalSetpoint)
    setAutoTuneConfig(defaultAutoTuneConfig(motor.nominalSetpoint))
    optimizerRef.current = new BayesianOptimizer(defaultBounds(motor.mechanism.type), motor.mechanism.type)
  }

  function syncMotorToProject(project: Project, motorId: string): Project {
    const bestEntry = allEntriesRef.current.length > 0
      ? allEntriesRef.current.reduce((b, e) => e.metrics.score < b.metrics.score ? e : b)
      : null
    const gainsToSave = bestEntry?.gains ?? gains
    return {
      ...project,
      updatedAt: new Date().toISOString(),
      motors: project.motors.map(m =>
        m.id === motorId
          ? { ...m, gains: gainsToSave, mechanism, nominalSetpoint: setpointDisplay }
          : m
      )
    }
  }

  async function saveProject(project: Project, path: string | null): Promise<string | null> {
    const data = JSON.stringify(project, null, 2)
    if (path) {
      await window.api.saveProject(path, data)
      await window.api.addRecentProject({ filePath: path, name: project.name, motorCount: project.motors.length, updatedAt: project.updatedAt })
      return path
    } else {
      const result = await window.api.saveProjectAs(data, project.name)
      if (result.success && result.filePath) {
        await window.api.addRecentProject({ filePath: result.filePath, name: project.name, motorCount: project.motors.length, updatedAt: project.updatedAt })
        return result.filePath
      }
      return null
    }
  }

  async function handleSaveProject(): Promise<void> {
    if (!activeProject) return
    setIsSaving(true)
    const synced = activeMotorId ? syncMotorToProject(activeProject, activeMotorId) : { ...activeProject, updatedAt: new Date().toISOString() }
    setActiveProject(synced)
    const savedPath = await saveProject(synced, activeProjectPath)
    if (savedPath) setActiveProjectPath(savedPath)
    setIsSaving(false)
  }

  function handleSelectMotor(motorId: string): void {
    if (motorId === activeMotorId) return
    // Sync current motor before switching
    if (activeProject && activeMotorId) {
      setActiveProject(prev => prev ? syncMotorToProject(prev, activeMotorId) : prev)
    }
    setActiveMotorId(motorId)
    const motor = activeProject?.motors.find(m => m.id === motorId)
    if (motor) loadMotor(motor)
  }

  function handleAddMotor(motor: MotorProfile): void {
    if (!activeProject) return
    const updated = { ...activeProject, motors: [...activeProject.motors, motor], updatedAt: new Date().toISOString() }
    setActiveProject(updated)
    setActiveMotorId(motor.id)
    loadMotor(motor)
  }

  function openAddMotorModal(): void {
    setConfigMotorId(null)
    setMotorConfigDraft(defaultMotorProfile('New Motor'))
    setShowMotorConfig(true)
  }

  function openConfigureMotorModal(id: string): void {
    const motor = activeProject?.motors.find(m => m.id === id)
    if (!motor) return
    setConfigMotorId(id)
    setMotorConfigDraft({ ...motor })
    setShowMotorConfig(true)
  }

  function handleSaveMotorConfig(motor: MotorProfile): void {
    setShowMotorConfig(false)
    if (configMotorId === null) {
      handleAddMotor(motor)
    } else {
      if (activeMotorId === configMotorId) {
        setMechanism(motor.mechanism)
        setSetpointDisplay(motor.nominalSetpoint)
      }
      setActiveProject(prev => prev ? {
        ...prev,
        motors: prev.motors.map(m => m.id === configMotorId ? motor : m),
        updatedAt: new Date().toISOString(),
      } : prev)
    }
    setMotorConfigDraft(null)
    setConfigMotorId(null)
  }

  function handleRenameProject(name: string): void {
    setActiveProject(prev => prev ? { ...prev, name, updatedAt: new Date().toISOString() } : prev)
  }

  function handleRenameMotor(id: string, name: string): void {
    setActiveProject(prev => prev ? {
      ...prev,
      motors: prev.motors.map(m => m.id === id ? { ...m, name } : m)
    } : prev)
  }

  function handleDeleteMotor(id: string): void {
    if (!activeProject) return
    const remaining = activeProject.motors.filter(m => m.id !== id)
    setActiveProject({ ...activeProject, motors: remaining, updatedAt: new Date().toISOString() })
    if (activeMotorId === id) {
      if (remaining.length > 0) {
        setActiveMotorId(remaining[0].id)
        loadMotor(remaining[0])
      } else {
        setActiveMotorId(null)
        resetTunerState()
      }
    }
  }

  function openProjectData(filePath: string, data: string): void {
    try {
      const project = JSON.parse(data) as Project
      setActiveProject(project)
      setActiveProjectPath(filePath)
      setAppView('project')
      if (project.motors.length > 0) {
        setActiveMotorId(project.motors[0].id)
        loadMotor(project.motors[0])
      } else {
        setActiveMotorId(null)
        resetTunerState()
      }
    } catch {}
  }

  async function handleOpenProject(): Promise<void> {
    const result = await window.api.openProject()
    if (result.success && result.filePath && result.data) {
      openProjectData(result.filePath, result.data)
    }
  }

  async function handleOpenRecent(filePath: string): Promise<void> {
    try {
      const result = await window.api.openProjectByPath(filePath)
      if (result.success && result.filePath && result.data) {
        openProjectData(result.filePath, result.data)
      } else if (result.notFound) {
        await window.api.removeRecentProject(filePath)
      }
    } catch {}
  }

  function handleNewProject(name: string): void {
    const project = defaultProject(name)
    setActiveProject(project)
    setActiveProjectPath(null)  // no file yet, will prompt on first save
    setActiveMotorId(null)
    resetTunerState()
    setAppView('project')
  }

  function handleCloseProject(): void {
    setActiveProject(null)
    setActiveProjectPath(null)
    setActiveMotorId(null)
    resetTunerState()
    setAppView('launcher')
  }

  // ── Tune completion → mark motor as tuned ───────────────────────────────────

  // When auto-tune finishes, check if best score met target → mark motor as tuned
  useEffect(() => {
    if (!autoTuneDone || !activeMotorId || !activeProject) return
    const entries = allEntriesRef.current
    if (entries.length === 0) return
    const bestScore = entries.reduce((b, e) => e.metrics.score < b ? e.metrics.score : b, Infinity)
    const target = autoTuneConfig.targetScore
    if (bestScore <= target) {
      setActiveProject(prev => {
        if (!prev) return null
        return {
          ...prev,
          motors: prev.motors.map(m =>
            m.id === activeMotorId
              ? { ...m, tuneStatus: 'tuned' as const, tuneBestScore: bestScore, tuneTargetScore: target, tuneDate: new Date().toISOString() }
              : m
          )
        }
      })
    }
  }, [autoTuneDone])

  // ── Derived display values ──────────────────────────────────────────────────

  const unitLabel = displayUnitLabel(mechanism)
  const activeOpt = currentPhase >= 2 ? fineTuneOptRef.current : optimizerRef.current
  const phaseInfo: PhaseInfo = activeOpt?.getPhaseInfo() ?? {
    phase: 'structured',
    label: 'Structured Sweep',
    description: 'Initializing…',
    progressPct: 0
  }

  if (appView === 'launcher') {
    return (
      <div className="app-layout">
        <Launcher
          onNewProject={handleNewProject}
          onOpenProject={handleOpenProject}
          onOpenRecent={handleOpenRecent}
          onRemoveRecent={fp => window.api.removeRecentProject(fp)}
        />
      </div>
    )
  }

  return (
    <>
      <div className={`app-layout ${activeProject ? 'app-layout-project' : ''}`}>
        {activeProject && (
          <div className="panel panel-sidebar">
            <ProjectSidebar
              project={activeProject}
              activeMotorId={activeMotorId}
              onSelectMotor={handleSelectMotor}
              onAddMotor={openAddMotorModal}
              onConfigureMotor={openConfigureMotorModal}
              onRenameMotor={handleRenameMotor}
              onDeleteMotor={handleDeleteMotor}
              onRenameProject={handleRenameProject}
              onSave={handleSaveProject}
              onClose={handleCloseProject}
              isSaving={isSaving}
            />
          </div>
        )}

        <div className="panel panel-left">
          <MechanismPanel
            mechanism={mechanism}
            setpoint={setpointDisplay}
            onMechanismChange={setMechanism}
            onSetpointChange={setSetpointDisplay}
            unitLabel={unitLabel}
          />
        </div>

        <div className="panel panel-center">
          <StepGraph
            data={stepData}
            segmentBoundaries={segmentBoundaries}
            unitLabel={unitLabel}
            mechanismType={mechanism.type}
            metrics={metrics}
          />
        </div>

        <div className="panel panel-right">
          <GainsPanel
            gains={gains}
            metrics={metrics}
            mechanism={mechanism}
            nominalSetpoint={setpointDisplay}
            testCount={testCount}
            isRunning={isRunning}
            phaseInfo={phaseInfo}
            history={history}
            unitLabel={unitLabel}
            currentPhase={currentPhase}
            consecutiveHits={consecutiveHits}
            phaseExpCount={phaseExpCount}
            phaseExtCount={phaseExtCount}
            phaseBestScore={phaseBestScore}
            autoTuneRunning={autoTuneRunning}
            autoTuneDone={autoTuneDone}
            autoTuneFailed={autoTuneFailed}
            autoTuneConfig={autoTuneConfig}
            manualRunning={manualRunning}
            manualRunProgress={manualRunProgress}
            onGainsChange={setGains}
            onRunTest={connectionMode === 'sim' ? runSim : startLiveTest}
            onSuggest={suggestGains}
            onExport={exportJava}
            onStartAutoTune={startAutoTune}
            onStopAutoTune={stopAutoTune}
            onAcceptTune={acceptTune}
            onStartManualRun={startManualRun}
            onStopManualRun={stopManualRun}
            onAutoTuneConfigChange={setAutoTuneConfig}
          />
        </div>

        <StatusBar
          connectionMode={connectionMode}
          connectionStatus={connectionStatus}
          teamNumber={teamNumber}
          testCount={testCount}
          onTeamNumberChange={setTeamNumber}
          onConnect={connectNT4}
          onDisconnect={disconnectNT4}
          onSwitchToSim={() => { disconnectNT4(); setConnectionMode('sim') }}
        />
      </div>

      {showMotorConfig && motorConfigDraft && (
        <MotorConfigModal
          motor={motorConfigDraft}
          mode={configMotorId === null ? 'add' : 'edit'}
          onSave={handleSaveMotorConfig}
          onCancel={() => { setShowMotorConfig(false); setMotorConfigDraft(null); setConfigMotorId(null) }}
        />
      )}
    </>
  )
}
