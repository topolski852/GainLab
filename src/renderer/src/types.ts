// ─── Mechanism ────────────────────────────────────────────────────────────────

export type MechanismType = 'flywheel' | 'arm' | 'elevator'
export type MotorType = 'falcon500' | 'krakenX60' | 'krakenX60Trap' | 'krakenX44' | 'krakenX44Trap' | 'minion'

export interface MechanismConfig {
  type: MechanismType
  motorType: MotorType
  numMotors: number
  gearRatio: number
  massKg: number
  // flywheel only
  radiusM: number
  // arm only
  lengthM: number
  startAngleDeg: number
  // elevator only
  spoolRadiusM: number
  startHeightM: number
}

// ─── Gains (CTRE Phoenix 6 units) ─────────────────────────────────────────────

export interface Gains {
  kP: number
  kI: number
  kD: number
  kS: number
  kV: number
  kA: number
  kG: number
}

// ─── Test sequences ────────────────────────────────────────────────────────────

export interface TestStep {
  setpointDisplay: number   // in display units (RPM / deg / m)
  durationS: number
}

// ─── Step Response ────────────────────────────────────────────────────────────

export interface StepResponsePoint {
  time: number
  setpoint: number    // display units — changes between steps in multi-step tests
  actual: number      // display units
}

export interface StepMetrics {
  riseTimeS: number
  overshootPct: number
  settlingTimeS: number
  steadyStateError: number
  oscillations: number    // zero-crossings of error inside 20% band (post-transient)
  score: number           // composite quality score (lower = better)
}

// ─── Optimizer ────────────────────────────────────────────────────────────────

export type ExplorationPhase = 'structured' | 'ucb'

export interface PhaseInfo {
  phase: ExplorationPhase
  label: string
  description: string
  progressPct: number   // 0–100 within current phase
}

export interface OptimizerEntry {
  gains: Gains
  metrics: StepMetrics
  testIndex: number
  steps: TestStep[]     // which sequence was run for this experiment
}

export interface GainBound {
  min: number
  max: number
}

export type GainBounds = Record<keyof Gains, GainBound>

// ─── NT4 / Connection ─────────────────────────────────────────────────────────

export type ConnectionMode = 'sim' | 'live'
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface NT4Config {
  teamNumber: string
  topicPrefix: string
}

// ─── App State ────────────────────────────────────────────────────────────────

export interface AppState {
  mechanism: MechanismConfig
  gains: Gains
  setpointDisplay: number
  stepResponseData: StepResponsePoint[]
  segmentBoundaries: number[]     // times (seconds) where setpoint changes
  metrics: StepMetrics | null
  optimizerHistory: OptimizerEntry[]
  connectionMode: ConnectionMode
  connectionStatus: ConnectionStatus
  nt4Config: NT4Config
  isRunning: boolean
  testCount: number
}
