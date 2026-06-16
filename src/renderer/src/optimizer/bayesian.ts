import { Gains, GainBounds, OptimizerEntry } from '../types'

// ─── Gaussian Process ─────────────────────────────────────────────────────────
// Squared-exponential (RBF) kernel, Cholesky-based exact inference.
// Operates on normalized [0,1] gain vectors.

const NOISE_VAR = 0.01     // observation noise variance
const AMPLITUDE = 1.0      // kernel amplitude
const LENGTH_SCALE = 0.3   // RBF length scale (in normalized space)

function rbf(a: number[], b: number[]): number {
  let sq = 0
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] - b[i]) / LENGTH_SCALE
    sq += d * d
  }
  return AMPLITUDE * Math.exp(-0.5 * sq)
}

// Cholesky decomposition of positive-definite matrix A → lower triangular L
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

// Solve L·x = b (forward), then Lᵀ·x = b (backward)
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

interface GPResult {
  mean: number
  std: number
}

class GaussianProcess {
  private X: number[][] = []   // normalized training inputs
  private y: number[] = []     // training targets (quality: higher = better)
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

  predict(xStar: number[]): GPResult {
    if (this.X.length === 0) return { mean: 0, std: 1 }
    const kStar = this.X.map(x => rbf(x, xStar))
    const kStarStar = rbf(xStar, xStar)
    const mean = kStar.reduce((s, k, i) => s + k * this.alpha[i], 0)
    const v = solveCholesky(this.L, kStar)
    const variance = kStarStar - v.reduce((s, vi, i) => s + vi * kStar[i], 0)
    return { mean, std: Math.sqrt(Math.max(0, variance)) }
  }
}

// ─── Normal distribution helpers ──────────────────────────────────────────────

function normalCDF(z: number): number {
  // Abramowitz & Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)
  const p = 1 - pdf * poly
  return z >= 0 ? p : 1 - p
}

function normalPDF(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)
}

// Expected Improvement acquisition (maximize quality; yBest = best observed quality so far)
function expectedImprovement(mean: number, std: number, yBest: number, xi = 0.01): number {
  if (std < 1e-8) return 0
  const z = (mean - yBest - xi) / std
  return (mean - yBest - xi) * normalCDF(z) + std * normalPDF(z)
}

// ─── Gain space normalization ─────────────────────────────────────────────────

export function defaultBounds(hasGravity: boolean): GainBounds {
  return {
    kP: { min: 0.001, max: 10 },
    kI: { min: 0, max: 1 },
    kD: { min: 0, max: 1 },
    kS: { min: 0, max: 1 },
    kV: { min: 0, max: 0.5 },
    kA: { min: 0, max: 0.5 },
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

function randomVector(dim: number): number[] {
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

  // quality = -score (higher = better), stored so GP maximizes quality
  observe(entry: OptimizerEntry): void {
    this.history.push(entry)
    const X = this.history.map(e => normalize(e.gains, this.bounds))
    const y = this.history.map(e => -e.metrics.score)  // negate: lower score = higher quality
    this.gp.fit(X, y)
  }

  // Suggest next gains via EI maximization over random samples + local hill-climbing
  suggest(fixedGains: Partial<Gains> = {}): Gains {
    if (this.history.length < 2) {
      return this.randomGains(fixedGains)
    }

    const yBest = Math.max(...this.history.map(e => -e.metrics.score))
    const CANDIDATES = 512
    let bestEI = -Infinity
    let bestVec = randomVector(this.dim)

    for (let c = 0; c < CANDIDATES; c++) {
      const v = randomVector(this.dim)
      const { mean, std } = this.gp.predict(v)
      const ei = expectedImprovement(mean, std, yBest)
      if (ei > bestEI) {
        bestEI = ei
        bestVec = v
      }
    }

    // Simple coordinate-wise hill climb from the best candidate
    for (let iter = 0; iter < 20; iter++) {
      let improved = false
      for (let d = 0; d < this.dim; d++) {
        for (const delta of [-0.05, 0.05]) {
          const v = [...bestVec]
          v[d] = Math.max(0, Math.min(1, v[d] + delta))
          const { mean, std } = this.gp.predict(v)
          const ei = expectedImprovement(mean, std, yBest)
          if (ei > bestEI) {
            bestEI = ei
            bestVec = v
            improved = true
          }
        }
      }
      if (!improved) break
    }

    const suggested = denormalize(bestVec, this.bounds)
    // Apply any fixed gains (kV and kG from physics are good starting points)
    return { ...suggested, ...fixedGains }
  }

  randomGains(fixedGains: Partial<Gains> = {}): Gains {
    const v = randomVector(this.dim)
    const g = denormalize(v, this.bounds)
    // Keep kV and kG close to physics baseline for first random explorations
    return { ...g, ...fixedGains }
  }

  bestEntry(): OptimizerEntry | null {
    if (this.history.length === 0) return null
    return this.history.reduce((best, e) => e.metrics.score < best.metrics.score ? e : best)
  }

  get experimentCount(): number {
    return this.history.length
  }
}
