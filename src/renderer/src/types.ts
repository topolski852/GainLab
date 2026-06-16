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
// Velocity control (flywheel): kP [V/(rot/s)], kV [V·s/rot], kA [V·s²/rot]
// Position control (arm/elevator): kP [V/rot], kD [V·s/rot]
// kS [V], kG [V]

export interface Gains {
  kP: number
  kI: number
  kD: number
  kS: number
  kV: number
  kA: number
  kG: number
}

// ─── Step Response ────────────────────────────────────────────────────────────

export interface StepResponsePoint {
  time: number      // seconds
  setpoint: number  // in display units (RPM, deg, m)
  actual: number    // in display units
}

export interface StepMetrics {
  riseTimeS: number      // 10% → 90% of setpoint, -1 if never reached
  overshootPct: number   // max overshoot above setpoint (%)
  settlingTimeS: number  // time to enter and stay within 2% band
  steadyStateError: number // mean absolute error over last 20% of test
  score: number          // composite quality score (lower = better)
}

// ─── Optimizer ────────────────────────────────────────────────────────────────

export interface OptimizerEntry {
  gains: Gains
  metrics: StepMetrics
  testIndex: number
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
  setpointDisplay: number  // setpoint in display units (RPM / deg / m)
  stepResponseData: StepResponsePoint[]
  metrics: StepMetrics | null
  optimizerHistory: OptimizerEntry[]
  connectionMode: ConnectionMode
  connectionStatus: ConnectionStatus
  nt4Config: NT4Config
  isRunning: boolean
  testCount: number
}
