import { Gains, GainBounds, OptimizerEntry, PhaseInfo, MechanismType, AutoTuneConfig } from '../types'

// ─── Gaussian Process ─────────────────────────────────────────────────────────
// Squared-exponential (RBF) kernel, Cholesky-based exact inference.
// Operates on normalized [0,1] gain vectors.

const NOISE_VAR    = 0.01
const AMPLITUDE    = 1.0
const LENGTH_SCALE = 0.3

function rbf(a: number[], b: number[]): number {
  let sq = 0
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] - b[i]) / LENGTH_SCALE
    sq += d * d
  }
  return AMPLITUDE * Math.exp(-0.5 * sq)
}

function cholesky(A: number[][]): number[][] {
  const n = A.length
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j]
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]
      L[i][j] = i === j ? Math.sqrt(Math.max(1e-12, s)) : s / (L[j][j] + 1e-12)
    }
  }
  return L
}

function solveCholesky(L: number[][], b: number[]): number[] {
  const n = L.length
  const y = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    let s = b[i]
    for (let j = 0; j < i; j++) s -= L[i][j] * y[j]
    y[i] = s / (L[i][i] + 1e-12)
  }
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]
    for (let j = i + 1; j < n; j++) s -= L[j][i] * x[j]
    x[i] = s / (L[i][i] + 1e-12)
  }
  return x
}

class GaussianProcess {
  private X: number[][] = []
  private y: number[] = []
  private L: number[][] = []
  private alpha: number[] = []

  fit(X: number[][], y: number[]): void {
    this.X = X
    this.y = y
    const n = X.length
    const K: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) =>
        rbf(X[i], X[j]) + (i === j ? NOISE_VAR : 0)
      )
    )
    this.L = cholesky(K)
    this.alpha = solveCholesky(this.L, y)
  }

  predict(xStar: number[]): { mean: number; std: number } {
    if (this.X.length === 0) return { mean: 0, std: 1 }
    const kStar     = this.X.map(x => rbf(x, xStar))
    const kStarStar = rbf(xStar, xStar)
    const mean      = kStar.reduce((s, k, i) => s + k * this.alpha[i], 0)
    const v         = solveCholesky(this.L, kStar)
    const variance  = kStarStar - v.reduce((s, vi, i) => s + vi * kStar[i], 0)
    return { mean, std: Math.sqrt(Math.max(0, variance)) }
  }
}

// ─── Acquisition: Upper Confidence Bound ──────────────────────────────────────
// UCB = mean + β·std  (maximize).
// β decays from 1.8→0.3 over the first 50 UCB experiments. Starting at 1.8
// (not 2.5) reduces the tendency to leap to high-uncertainty extreme gain
// values that the structured phase already showed are poor.

function getBeta(ucbCount: number): number {
  const decay = Math.pow(Math.max(0, 1 - ucbCount / 50), 0.5)
  return Math.max(0.3, 1.8 * decay)
}

// Diversity: minimum euclidean distance to any observed normalized point
function minDistTo(v: number[], observed: number[][]): number {
  if (observed.length === 0) return Infinity
  let minSq = Infinity
  for (const o of observed) {
    let sq = 0
    for (let i = 0; i < v.length; i++) { const d = v[i] - o[i]; sq += d * d }
    if (sq < minSq) minSq = sq
  }
  return Math.sqrt(minSq)
}

// ─── Structured initial exploration ───────────────────────────────────────────
// First STRUCTURED_COUNT experiments sweep kP so the GP has meaningful
// observations spanning the gain space before UCB runs.
//
// Velocity control (flywheel): kV feedforward handles steady state, so kP<0.05
// is practically useless — the motor barely responds differently. Starting at
// 0.05 avoids tests that visually look broken (motor barely moves) and still
// gives the GP a clear low-end reference.
//
// Position control: full range needed; kP=0.001 can matter on high-ratio arms.

const STRUCTURED_COUNT = 7
const FLYWHEEL_KP_SWEEP  = [0.05, 0.15, 0.4, 0.9, 1.8, 3.5, 5.0]
const POSITION_KP_SWEEP  = [0.001, 0.01, 0.05, 0.2, 0.8, 3.0, 8.0]

// ─── Gain space normalization ─────────────────────────────────────────────────

export function defaultBounds(mechType: MechanismType): GainBounds {
  // Velocity control (flywheel): kD MUST be 0 — differentiating velocity error
  // produces a massive voltage spike at every setpoint change (kD × Δerror/dt_pid),
  // which brakes the motor hard and makes the system appear to stall. kA handles
  // acceleration feedforward; kD has no useful role in a velocity loop.
  // kS max = 0.5V: with a well-tuned kV, kS > ~0.3V fights the feedforward and
  // creates steady-state error rather than fixing it.
  if (mechType === 'flywheel') {
    return {
      kP: { min: 0.001, max: 5    },
      kI: { min: 0,     max: 0.05 },
      kD: { min: 0,     max: 0    },  // zero: derivative kickback destroys velocity loops
      kS: { min: 0,     max: 0.5  },  // low: kV feedforward covers steady-state
      kV: { min: 0,     max: 0.5  },
      kA: { min: 0,     max: 0.5  },
      kG: { min: 0,     max: 0    },
    }
  }
  // Position control (arm / elevator): kD for damping, kG for gravity.
  // kS and kV require a motion-profile velocity setpoint (MotionMagicVoltage);
  // for static PositionVoltage setpoints both terms are zero and excluded from search.
  return {
    kP: { min: 0.001, max: 10  },
    kI: { min: 0,     max: 0.5 },
    kD: { min: 0,     max: 1   },
    kS: { min: 0,     max: 0   },
    kV: { min: 0,     max: 0   },
    kA: { min: 0,     max: 0   },
    kG: mechType !== 'flywheel' ? { min: 0, max: 2 } : { min: 0, max: 0 },
  }
}

const GAIN_KEYS: (keyof Gains)[] = ['kP', 'kI', 'kD', 'kS', 'kV', 'kA', 'kG']

function normalize(gains: Gains, bounds: GainBounds): number[] {
  return GAIN_KEYS.map(k => {
    const { min, max } = bounds[k]
    const range = max - min
    return range > 0 ? (gains[k] - min) / range : 0
  })
}

function denormalize(v: number[], bounds: GainBounds): Gains {
  const g: Partial<Gains> = {}
  GAIN_KEYS.forEach((k, i) => {
    const { min, max } = bounds[k]
    g[k] = Math.max(min, Math.min(max, min + v[i] * (max - min)))
  })
  return g as Gains
}

function randomVec(dim: number): number[] {
  return Array.from({ length: dim }, () => Math.random())
}

// ─── Phase N bounds narrowing ─────────────────────────────────────────────────
// Computes a tighter search space centred on the best observed gains.
// radius: fraction of best value to search ±, e.g. 0.20 = ±20%.
// For gains near zero the absolute range is used (percentage breaks down near 0).

function narrowedBounds(bestGains: Gains, phase1Bounds: GainBounds, radius: number): GainBounds {
  const result = {} as GainBounds
  for (const k of GAIN_KEYS) {
    const best = bestGains[k]
    const { min: p1min, max: p1max } = phase1Bounds[k]
    const p1Range = p1max - p1min
    if (p1Range <= 0) { result[k] = { min: p1min, max: p1max }; continue }
    let lo: number, hi: number
    if (best <= p1Range * 0.03) {
      // Gain is near zero: use radius×2 fraction of phase-1 range from the floor.
      // This automatically narrows with each phase (radius 0.2→0.4 range, 0.1→0.2 range…).
      lo = p1min
      hi = Math.min(p1max, p1min + p1Range * (radius * 2))
    } else {
      // Centre on best ± radius, clamp to phase-1 bounds
      lo = Math.max(p1min, best * (1 - radius))
      hi = Math.min(p1max, best * (1 + radius))
    }
    result[k] = { min: lo, max: Math.max(lo + 1e-9, hi) }
  }
  return result
}

function gainsInBounds(gains: Gains, bounds: GainBounds): boolean {
  return GAIN_KEYS.every(k => gains[k] >= bounds[k].min && gains[k] <= bounds[k].max)
}

// Score cap: clamp extreme outlier scores before fitting the GP so that
// a single catastrophically bad test (e.g. kP=0.05 giving score=7000) doesn't
// warp the GP surface and push UCB into re-exploring clearly bad regions.
const MAX_GP_SCORE = 150

// ─── Bayesian Optimizer ───────────────────────────────────────────────────────

export class BayesianOptimizer {
  private gp = new GaussianProcess()
  private history: OptimizerEntry[] = []
  private bounds: GainBounds
  private mechType: MechanismType
  private dim = GAIN_KEYS.length
  private kpSweep: number[]
  private isFineTune: boolean
  private phaseLabel: string

  constructor(
    bounds: GainBounds,
    mechType: MechanismType = 'flywheel',
    isFineTune = false,
    phaseLabel = 'Phase 2'
  ) {
    this.bounds     = bounds
    this.mechType   = mechType
    this.kpSweep    = mechType === 'flywheel' ? FLYWHEEL_KP_SWEEP : POSITION_KP_SWEEP
    this.isFineTune = isFineTune
    this.phaseLabel = phaseLabel
  }

  // Create a fine-tune optimizer for a given phase number with narrowed bounds
  // centred on the best observed gains. Pre-seeded with any history entries that
  // fall within the new bounds so the GP starts with useful context immediately.
  // radius: search ± fraction of best value (0.20 = ±20%).
  static createPhaseN(
    phaseNum: number,
    history: OptimizerEntry[],
    bestGains: Gains,
    phase1Bounds: GainBounds,
    mechType: MechanismType,
    radius: number
  ): BayesianOptimizer {
    const phaseBounds = narrowedBounds(bestGains, phase1Bounds, radius)
    const opt = new BayesianOptimizer(phaseBounds, mechType, true, `Phase ${phaseNum}`)
    for (const entry of history) {
      if (gainsInBounds(entry.gains, phaseBounds)) opt.observe(entry)
    }
    return opt
  }

  // Legacy helper kept for backward compatibility
  static createPhase2(
    history: OptimizerEntry[],
    bestGains: Gains,
    phase1Bounds: GainBounds,
    mechType: MechanismType
  ): BayesianOptimizer {
    return BayesianOptimizer.createPhaseN(2, history, bestGains, phase1Bounds, mechType, 0.20)
  }

  // Convenience: create the next fine-tune phase from an AutoTuneConfig
  static createNextPhase(
    phaseNum: number,
    history: OptimizerEntry[],
    bestGains: Gains,
    phase1Bounds: GainBounds,
    mechType: MechanismType,
    cfg: AutoTuneConfig
  ): BayesianOptimizer {
    const radiusIdx = phaseNum - 2  // phase 2 → index 0
    const radius = cfg.phaseRadii[radiusIdx] ?? cfg.phaseRadii[cfg.phaseRadii.length - 1]
    return BayesianOptimizer.createPhaseN(phaseNum, history, bestGains, phase1Bounds, mechType, radius)
  }

  get currentBounds(): GainBounds { return this.bounds }

  // quality = −score (higher = better), GP maximizes quality.
  // Scores are clamped before fitting so catastrophic outliers don't distort
  // the GP surface and cause UCB to re-explore clearly bad gain regions.
  observe(entry: OptimizerEntry): void {
    this.history.push(entry)
    const minForGP = this.isFineTune ? 2 : STRUCTURED_COUNT
    if (this.history.length >= minForGP) {
      const X = this.history.map(e => normalize(e.gains, this.bounds))
      const y = this.history.map(e => -Math.min(e.metrics.score, MAX_GP_SCORE))
      this.gp.fit(X, y)
    }
  }

  suggest(fixedGains: Partial<Gains> = {}): Gains {
    const n = this.history.length

    // ── Structured phase (Phase 1 only) ──────────────────────────────────────
    if (!this.isFineTune && n < STRUCTURED_COUNT) {
      const base: Gains = {
        kP: this.kpSweep[n],
        kI: 0,
        kD: 0,
        kS: 0,       // kV feedforward handles steady state; kS=0.25 fights it
        kV: 0,
        kA: 0,
        kG: 0,
        ...fixedGains,
      }
      base.kP = this.kpSweep[n]   // fixedGains must not override the sweep kP
      return base
    }

    // ── UCB phase ─────────────────────────────────────────────────────────────
    const ucbCount = n - (this.isFineTune ? 0 : STRUCTURED_COUNT)
    // Fine-tune phases use much lower beta: mostly exploitation, minimal exploration.
    const beta = this.isFineTune
      ? Math.max(0.05, 0.4 * Math.pow(Math.max(0, 1 - ucbCount / 30), 0.5))
      : getBeta(ucbCount)
    const observed = this.history.map(e => normalize(e.gains, this.bounds))

    let bestScore = -Infinity
    let bestVec   = randomVec(this.dim)
    const CANDIDATES = 512
    // Reduced diversity floor (0.05 vs 0.08) so UCB can stay near observed
    // good regions rather than being forced into uncharted extreme territory.
    let diverseMin   = 0.05

    // Sample candidates; relax diversity requirement if nothing diverse found
    while (diverseMin >= 0) {
      let found = false
      for (let c = 0; c < CANDIDATES; c++) {
        const v = randomVec(this.dim)
        if (diverseMin > 0 && minDistTo(v, observed) < diverseMin) continue
        const { mean, std } = this.gp.predict(v)
        const s = mean + beta * std
        if (s > bestScore) { bestScore = s; bestVec = v; found = true }
      }
      if (found) break
      diverseMin -= 0.02
    }

    // Coordinate-wise hill-climb from best candidate
    for (let iter = 0; iter < 20; iter++) {
      let improved = false
      for (let d = 0; d < this.dim; d++) {
        for (const delta of [-0.05, 0.05]) {
          const v = [...bestVec]
          v[d] = Math.max(0, Math.min(1, v[d] + delta))
          if (minDistTo(v, observed) < 0.03) continue
          const { mean, std } = this.gp.predict(v)
          const s = mean + beta * std
          if (s > bestScore) { bestScore = s; bestVec = v; improved = true }
        }
      }
      if (!improved) break
    }

    // Prevent returning a near-duplicate of an already-observed point. Compare in
    // actual output gain space AFTER fixedGains overrides — checking raw bestVec
    // misses duplicates where fixedGains collapses different vectors to identical
    // output (e.g. kV/kA jitter in bestVec is overridden, leaving kP/kI unchanged).
    const MIN_SUGGEST_DIST = 0.015
    const JITTER = 0.06
    const gainObserved = this.history.map(e => normalize(e.gains, this.bounds))

    const result = { ...denormalize(bestVec, this.bounds), ...fixedGains }
    if (gainObserved.length > 0 && minDistTo(normalize(result, this.bounds), gainObserved) < MIN_SUGGEST_DIST) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const jittered = bestVec.map(v => Math.max(0, Math.min(1, v + (Math.random() * 2 - 1) * JITTER)))
        const jResult = { ...denormalize(jittered, this.bounds), ...fixedGains }
        if (minDistTo(normalize(jResult, this.bounds), gainObserved) >= MIN_SUGGEST_DIST || attempt === 3) {
          return jResult
        }
      }
    }
    return result
  }

  getPhaseInfo(): PhaseInfo {
    const n = this.history.length
    if (this.isFineTune) {
      const ucbCount = n
      const beta = Math.max(0.05, 0.4 * Math.pow(Math.max(0, 1 - ucbCount / 30), 0.5)).toFixed(2)
      return {
        phase: 'ucb',
        label: `${this.phaseLabel} — Fine-tune`,
        description: `β = ${beta}  ·  ${n} experiment${n !== 1 ? 's' : ''}`,
        progressPct: Math.min(100, (n / 30) * 100)
      }
    }
    if (n < STRUCTURED_COUNT) {
      const nextKP = this.kpSweep[n]?.toFixed(3) ?? '—'
      return {
        phase: 'structured',
        label: 'Structured Sweep',
        description: `kP sweep  ${n} / ${STRUCTURED_COUNT}  (next kP = ${nextKP})`,
        progressPct: (n / STRUCTURED_COUNT) * 100
      }
    }
    const ucbCount = n - STRUCTURED_COUNT
    const beta = getBeta(ucbCount).toFixed(2)
    return {
      phase: 'ucb',
      label: 'Bayesian UCB',
      description: `β = ${beta}  ·  ${ucbCount} UCB experiment${ucbCount !== 1 ? 's' : ''}`,
      progressPct: Math.min(100, (ucbCount / 50) * 100)
    }
  }

  bestEntry(): OptimizerEntry | null {
    if (this.history.length === 0) return null
    return this.history.reduce((b, e) => e.metrics.score < b.metrics.score ? e : b)
  }

  get experimentCount(): number {
    return this.history.length
  }
}
