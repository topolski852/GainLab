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
  metrics: StepMetrics          // aggregate across all steps
  segmentMetrics: StepMetrics[] // per-step breakdown
  testIndex: number
  steps: TestStep[]
  tunePhase: number             // 1=Phase1 exploration, 2+=fine-tune
}

export interface GainBound {
  min: number
  max: number
}

export type GainBounds = Record<keyof Gains, GainBound>

// ─── Auto-Tune ────────────────────────────────────────────────────────────────
// Multi-phase tuning: Phase 1 explores broadly, each subsequent phase narrows
// the search radius around the best known gains.

export interface AutoTuneConfig {
  targetScore: number           // stop when N consecutive experiments score below this
  consecutiveHits: number       // how many consecutive sub-target scores to stop (default 5)
  numPhases: number             // total phases including Phase 1 (2–6, default 4)
  p1MaxExperiments: number      // max Phase 1 experiments before advancing (default 30)
  phaseMaxExperiments: number   // max experiments per fine-tune phase before advancing (default 20)
  p6MaxExperiments: number      // max experiments for Phase 6 match-test (default 8; sequences are ~2min long)
  // Search radius per fine-tune phase (fraction of best value, applied ±)
  // Index 0 = Phase 2, index 1 = Phase 3, … index 4 = Phase 6
  phaseRadii: number[]          // default [0.20, 0.10, 0.05, 0.025, 0.0125]
  // Fine-tune sequence parameters (phases 2–5 only; Phase 6 uses fixed match sequence)
  numSetpoints: number          // legacy — only used by Phase 1 getTestSequence
  dwellS: number                // scales dwell proportionally for phases 2–5 (1.0 = designed durations)
  randomization: number         // 0–1 jitter on setpoint spacing (default 0.15; capped per-phase internally)
  // Phase extension: if best-in-phase score doesn't clear the threshold after phaseMaxExperiments,
  // run up to phaseExtensionMax extra experiments before failing the auto-tune.
  phaseThresholds: number[]     // max acceptable score to advance from each phase [p1→2, p2→3, …, p5→6]
  phaseExtensionMax: number     // max extra experiments per phase before failing (default 50)
}

export function defaultAutoTuneConfig(nominalSetpoint?: number): AutoTuneConfig {
  void nominalSetpoint  // kept as param for future min/max setpoint defaults
  return {
    targetScore:         2.0,
    consecutiveHits:     5,
    numPhases:           6,
    p1MaxExperiments:    30,
    phaseMaxExperiments: 20,
    p6MaxExperiments:    8,
    phaseRadii:          [0.20, 0.10, 0.05, 0.025, 0.0125],
    numSetpoints:        6,
    dwellS:              1.0,
    randomization:       0.15,
    phaseThresholds:     [30, 15, 15, 20, 25],
    phaseExtensionMax:   50,
  }
}

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
