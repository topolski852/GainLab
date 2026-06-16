import { Gains, GainBounds, OptimizerEntry, PhaseInfo } from '../types'

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
// β decays from 2.5→0.3 over the first 50 UCB experiments, promoting
// exploration early and exploitation later.

function getBeta(ucbCount: number): number {
  const decay = Math.pow(Math.max(0, 1 - ucbCount / 50), 0.5)
  return Math.max(0.3, 2.5 * decay)
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
// First STRUCTURED_COUNT experiments sweep kP across three decades so the
// GP has meaningful observations spanning the whole gain space before UCB runs.

const STRUCTURED_COUNT = 7
const STRUCTURED_KP    = [0.001, 0.01, 0.05, 0.2, 0.5, 1.5, 5.0]

// ─── Gain space normalization ─────────────────────────────────────────────────

export function defaultBounds(hasGravity: boolean): GainBounds {
  return {
    kP: { min: 0.001, max: 10  },
    kI: { min: 0,     max: 1   },
    kD: { min: 0,     max: 1   },
    kS: { min: 0,     max: 1   },
    kV: { min: 0,     max: 0.5 },
    kA: { min: 0,     max: 0.5 },
    kG: hasGravity ? { min: 0, max: 2 } : { min: 0, max: 0 }
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

// ─── Bayesian Optimizer ───────────────────────────────────────────────────────

export class BayesianOptimizer {
  private gp = new GaussianProcess()
  private history: OptimizerEntry[] = []
  private bounds: GainBounds
  private dim = GAIN_KEYS.length

  constructor(bounds: GainBounds) {
    this.bounds = bounds
  }

  // quality = −score (higher = better), GP maximizes quality
  observe(entry: OptimizerEntry): void {
    this.history.push(entry)
    // Fit GP only once we have enough structured observations to be meaningful
    if (this.history.length >= STRUCTURED_COUNT) {
      const X = this.history.map(e => normalize(e.gains, this.bounds))
      const y = this.history.map(e => -e.metrics.score)
      this.gp.fit(X, y)
    }
  }

  suggest(fixedGains: Partial<Gains> = {}): Gains {
    const n = this.history.length

    // ── Structured phase ──────────────────────────────────────────────────────
    if (n < STRUCTURED_COUNT) {
      const base: Gains = {
        kP: STRUCTURED_KP[n],
        kI: 0,
        kD: 0,
        kS: 0.25,
        kV: 0,
        kA: 0,
        kG: 0,
        ...fixedGains,
      }
      base.kP = STRUCTURED_KP[n]   // fixedGains must not override the sweep kP
      return base
    }

    // ── UCB phase ─────────────────────────────────────────────────────────────
    const ucbCount = n - STRUCTURED_COUNT
    const beta     = getBeta(ucbCount)
    const observed = this.history.map(e => normalize(e.gains, this.bounds))

    let bestScore = -Infinity
    let bestVec   = randomVec(this.dim)
    const CANDIDATES = 512
    let diverseMin   = 0.08

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
          if (minDistTo(v, observed) < 0.04) continue   // soft diversity floor in hill-climb
          const { mean, std } = this.gp.predict(v)
          const s = mean + beta * std
          if (s > bestScore) { bestScore = s; bestVec = v; improved = true }
        }
      }
      if (!improved) break
    }

    return { ...denormalize(bestVec, this.bounds), ...fixedGains }
  }

  getPhaseInfo(): PhaseInfo {
    const n = this.history.length
    if (n < STRUCTURED_COUNT) {
      return {
        phase: 'structured',
        label: 'Structured Sweep',
        description: `Systematic kP sweep  ${n} / ${STRUCTURED_COUNT}`,
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
