import { useState, useRef, useCallback, useEffect } from 'react'
import { MechanismConfig, Gains, AppState, StepResponsePoint, OptimizerEntry, ConnectionStatus } from './types'
import { runSimulation, calculateBaselineGains, displayUnitLabel, defaultSetpoint } from './physics/simulator'
import { BayesianOptimizer, defaultBounds } from './optimizer/bayesian'
import { NT4Client, nt4URL } from './nt4/client'
import MechanismPanel from './components/MechanismPanel'
import StepGraph from './components/StepGraph'
import GainsPanel from './components/GainsPanel'
import StatusBar from './components/StatusBar'

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
  const [metrics, setMetrics] = useState<AppState['metrics']>(null)
  const [history, setHistory] = useState<OptimizerEntry[]>([])
  const [testCount, setTestCount] = useState(0)
  const [isRunning, setIsRunning] = useState(false)
  const [connectionMode, setConnectionMode] = useState<'sim' | 'live'>('sim')
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [teamNumber, setTeamNumber] = useState('1507')

  const optimizerRef = useRef<BayesianOptimizer | null>(null)
  const nt4Ref = useRef<NT4Client | null>(null)
  const liveBufferRef = useRef<StepResponsePoint[]>([])
  const liveStartTimeRef = useRef<number>(0)
  const liveTestActiveRef = useRef(false)

  // Rebuild optimizer when mechanism type changes (gain bounds differ)
  useEffect(() => {
    const hasGravity = mechanism.type === 'arm' || mechanism.type === 'elevator'
    optimizerRef.current = new BayesianOptimizer(defaultBounds(hasGravity))
    setHistory([])
    setTestCount(0)
    setStepData([])
    setMetrics(null)
    const newGains = calculateBaselineGains(mechanism)
    setGains(newGains)
    setSetpointDisplay(defaultSetpoint(mechanism))
  }, [mechanism.type, mechanism.motorType, mechanism.numMotors, mechanism.gearRatio,
      mechanism.massKg, mechanism.radiusM, mechanism.lengthM, mechanism.spoolRadiusM])

  // ── Simulation ──────────────────────────────────────────────────────────────

  const runSim = useCallback(() => {
    if (isRunning) return
    setIsRunning(true)

    // Run synchronously (fast enough for 2s @ 20ms record rate)
    setTimeout(() => {
      const { points, metrics: m } = runSimulation(mechanism, gains, setpointDisplay)
      setStepData(points)
      setMetrics(m)

      const entry: OptimizerEntry = {
        gains: { ...gains },
        metrics: m,
        testIndex: testCount
      }
      setHistory(prev => [...prev, entry])
      setTestCount(prev => prev + 1)
      optimizerRef.current?.observe(entry)
      setIsRunning(false)
    }, 0)
  }, [mechanism, gains, setpointDisplay, isRunning, testCount])

  // ── Bayesian suggest ────────────────────────────────────────────────────────

  const suggestGains = useCallback(() => {
    if (!optimizerRef.current) return
    const baseline = calculateBaselineGains(mechanism)
    // Fix kV and kG from physics — let optimizer tune kP, kI, kD, kS, kA
    const fixed: Partial<Gains> = { kV: baseline.kV, kG: baseline.kG }
    const suggested = optimizerRef.current.suggest(fixed)
    setGains(suggested)
  }, [mechanism])

  // ── NT4 live mode ───────────────────────────────────────────────────────────

  const connectNT4 = useCallback(() => {
    if (nt4Ref.current) {
      nt4Ref.current.disconnect()
    }

    const url = nt4URL(teamNumber)
    const prefix = '/gainlab'

    const client = new NT4Client(
      url,
      (topic, timestampUs, value) => {
        if (!liveTestActiveRef.current) return
        if (topic === `${prefix}/actual` && typeof value === 'number') {
          const elapsed = (performance.now() - liveStartTimeRef.current) / 1000
          liveBufferRef.current.push({
            time: parseFloat(elapsed.toFixed(3)),
            setpoint: setpointDisplay,
            actual: parseFloat((value as number).toFixed(4))
          })
          setStepData([...liveBufferRef.current])

          if (elapsed >= 2.0) {
            endLiveTest()
          }
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

    const prefix = '/gainlab'
    nt4Ref.current.publishValue(`${prefix}/setpoint`, setpointDisplay)
    nt4Ref.current.publishValue(`${prefix}/enabled`, 1)
  }, [isRunning, setpointDisplay])

  function endLiveTest(): void {
    liveTestActiveRef.current = false
    nt4Ref.current?.publishValue('/gainlab/enabled', 0)

    const pts = liveBufferRef.current
    if (pts.length > 0) {
      // Score the live step response using the same sim metrics calculator.
      // runSimulation with duration=0 skips physics and returns baseline metrics;
      // we re-use only the StepMetrics shape from a 0-duration sim as a placeholder
      // until a dedicated live-data metrics path is added.
      const { metrics: m } = runSimulation(mechanism, gains, setpointDisplay, 0)
      setMetrics(m)

      const entry: OptimizerEntry = { gains: { ...gains }, metrics: m, testIndex: testCount }
      setHistory(prev => [...prev, entry])
      setTestCount(prev => prev + 1)
      optimizerRef.current?.observe(entry)
    }
    setIsRunning(false)
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  const exportJava = useCallback(() => {
    const mechLabel = mechanism.type.charAt(0).toUpperCase() + mechanism.type.slice(1)
    const snippet = [
      `// GainLab — ${mechLabel} gains (CTRE Phoenix 6)`,
      `// Motor: ${mechanism.numMotors}× ${mechanism.motorType}, Gear ratio: ${mechanism.gearRatio}`,
      `// Tests run: ${testCount}`,
      ``,
      `TalonFXConfiguration config = new TalonFXConfiguration();`,
      `config.Slot0.kP = ${gains.kP.toFixed(4)};`,
      `config.Slot0.kI = ${gains.kI.toFixed(4)};`,
      `config.Slot0.kD = ${gains.kD.toFixed(4)};`,
      `config.Slot0.kS = ${gains.kS.toFixed(4)};`,
      `config.Slot0.kV = ${gains.kV.toFixed(4)};`,
      `config.Slot0.kA = ${gains.kA.toFixed(4)};`,
      `config.Slot0.kG = ${gains.kG.toFixed(4)};`,
      `motor.getConfigurator().apply(config);`
    ].join('\n')

    if (window.api) {
      window.api.saveSession(JSON.stringify({ gains, mechanism, snippet, testCount }))
    } else {
      navigator.clipboard.writeText(snippet).catch(() => {})
    }
  }, [gains, mechanism, testCount])

  const unitLabel = displayUnitLabel(mechanism)

  return (
    <div className="app-layout">
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
          unitLabel={unitLabel}
          mechanismType={mechanism.type}
          metrics={metrics}
        />
      </div>

      <div className="panel panel-right">
        <GainsPanel
          gains={gains}
          metrics={metrics}
          mechanismType={mechanism.type}
          testCount={testCount}
          isRunning={isRunning}
          canSuggest={testCount >= 2}
          onGainsChange={setGains}
          onRunTest={connectionMode === 'sim' ? runSim : startLiveTest}
          onSuggest={suggestGains}
          onExport={exportJava}
          history={history}
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
        onSwitchToSim={() => {
          disconnectNT4()
          setConnectionMode('sim')
        }}
      />
    </div>
  )
}
