import { MechanismConfig, Gains, StepResponsePoint, StepMetrics, TestStep, MechanismType } from '../types'
import { MOTORS, motorKvCTRE } from './motors'

const PHYSICS_DT = 0.005
const PID_DT     = 0.020
const SUPPLY_V   = 12.0
const GRAVITY    = 9.81

// ─── Unit conversions ─────────────────────────────────────────────────────────
// Simulation state is always SI (rad/s, rad, m/s, m).
// Gains live in CTRE Phoenix 6 rotor units (RPS, rotations).
// Display units are natural (RPM, deg, m) for readability.

function displayToSI(v: number, cfg: MechanismConfig): number {
  if (cfg.type === 'flywheel') return v * 2 * Math.PI / (60 * cfg.gearRatio)  // RPM → mech rad/s
  if (cfg.type === 'arm')      return v * Math.PI / 180                         // deg → rad
  return v                                                                       // elevator: m
}

function siToDisplay(v: number, cfg: MechanismConfig): number {
  if (cfg.type === 'flywheel') return v * cfg.gearRatio * 60 / (2 * Math.PI)  // mech rad/s → RPM
  if (cfg.type === 'arm')      return v * 180 / Math.PI                         // rad → deg
  return v
}

function siToCTRE(v: number, cfg: MechanismConfig): number {
  if (cfg.type === 'flywheel') return v * cfg.gearRatio / (2 * Math.PI)
  if (cfg.type === 'arm')      return v * cfg.gearRatio / (2 * Math.PI)
  return v * cfg.gearRatio / (2 * Math.PI * cfg.spoolRadiusM)
}

function displayToCTRE(v: number, cfg: MechanismConfig): number {
  return siToCTRE(displayToSI(v, cfg), cfg)
}

// ─── Physics state ────────────────────────────────────────────────────────────

interface PhysicsState {
  omega_mech: number   // rad/s at mechanism (flywheel velocity; arm/elevator angular rate)
  theta_mech: number   // rad (arm position; unused for flywheel)
  v_elev:     number   // m/s (elevator only)
  y_elev:     number   // m   (elevator only)
}

function defaultPhysicsState(cfg: MechanismConfig): PhysicsState {
  return {
    omega_mech: 0,
    theta_mech: cfg.type === 'arm' ? cfg.startAngleDeg * Math.PI / 180 : 0,
    v_elev:     0,
    y_elev:     cfg.type === 'elevator' ? cfg.startHeightM : 0,
  }
}

// ─── Effective inertia at mechanism output ────────────────────────────────────

function effectiveInertia(cfg: MechanismConfig): number {
  const motor = MOTORS[cfg.motorType]
  const J_motor = cfg.numMotors * motor.rotorInertiaKgM2 * cfg.gearRatio ** 2

  if (cfg.type === 'flywheel') {
    return 0.5 * cfg.massKg * cfg.radiusM ** 2 + J_motor
  }
  if (cfg.type === 'arm') {
    return (1 / 3) * cfg.massKg * cfg.lengthM ** 2 + J_motor
  }
  // elevator: linear (kg), motor inertia reflected through spool
  return cfg.massKg + J_motor / cfg.spoolRadiusM ** 2
}

// ─── Single-step simulation ───────────────────────────────────────────────────

function runStep(
  cfg: MechanismConfig,
  gains: Gains,
  setpointDisplay: number,
  durationS: number,
  initPhysics: PhysicsState,
  timeOffset: number
): { points: StepResponsePoint[]; finalPhysics: PhysicsState; metrics: StepMetrics } {
  const motor  = MOTORS[cfg.motorType]
  const J_eff  = effectiveInertia(cfg)
  const setpointCTRE = displayToCTRE(setpointDisplay, cfg)
  const freeSpeedRadps = motor.freeSpeedRPM * 2 * Math.PI / 60

  let { omega_mech, theta_mech, v_elev, y_elev } = initPhysics

  // Seed prevError from the actual initial state so the derivative term sees no
  // false spike on the first PID tick. Initialize pidTimer to PID_DT so the PID
  // fires on the very first physics step — otherwise voltage stays 0 for 20ms and
  // back-EMF decelerates the motor, producing the downward spike visible in the graph.
  const initActualCTRE = siToCTRE(
    cfg.type === 'flywheel' ? omega_mech :
    cfg.type === 'arm'      ? theta_mech : y_elev,
    cfg
  )
  let integral  = 0
  let prevError = setpointCTRE - initActualCTRE
  let pidTimer  = PID_DT
  let voltage   = 0

  const points: StepResponsePoint[] = []
  const RECORD_EVERY = Math.round(PID_DT / PHYSICS_DT)
  let step = 0

  for (let t = 0; t <= durationS + PHYSICS_DT * 0.5; t += PHYSICS_DT) {
    // PID update (20 ms)
    if (pidTimer >= PID_DT - PHYSICS_DT * 0.5) {
      const actualCTRE = cfg.type === 'flywheel'
        ? siToCTRE(omega_mech, cfg)
        : cfg.type === 'arm'
          ? siToCTRE(theta_mech, cfg)
          : siToCTRE(y_elev, cfg)

      const error  = setpointCTRE - actualCTRE
      integral    += error * PID_DT
      integral     = Math.max(-50, Math.min(50, integral))
      const deriv  = (error - prevError) / PID_DT
      prevError    = error

      let ff = gains.kS * Math.sign(setpointCTRE) + gains.kV * setpointCTRE
      if (cfg.type === 'arm')      ff += gains.kG * Math.cos(theta_mech)
      if (cfg.type === 'elevator') ff += gains.kG

      voltage  = gains.kP * error + gains.kI * integral + gains.kD * deriv + ff
      voltage  = Math.max(-SUPPLY_V, Math.min(SUPPLY_V, voltage))
      pidTimer = 0
    }
    pidTimer += PHYSICS_DT

    // Motor physics (5 ms)
    const omega_rotor =
      cfg.type === 'elevator'
        ? (v_elev / cfg.spoolRadiusM) * cfg.gearRatio
        : omega_mech * cfg.gearRatio

    const v_bemf   = omega_rotor / motor.KvRadPerSecPerVolt
    const current  = Math.max(-motor.stallCurrentA,
                       Math.min(motor.stallCurrentA,
                         (voltage - v_bemf) / motor.resistanceOhms))
    const tau_per  = current * motor.KtNmPerAmp

    if (cfg.type === 'flywheel') {
      omega_mech += (tau_per * cfg.numMotors * cfg.gearRatio / J_eff) * PHYSICS_DT

    } else if (cfg.type === 'arm') {
      const tau_grav = cfg.massKg * GRAVITY * (cfg.lengthM / 2) * Math.cos(theta_mech)
      const alpha    = (tau_per * cfg.numMotors * cfg.gearRatio - tau_grav) / J_eff
      omega_mech    += alpha * PHYSICS_DT
      theta_mech    += omega_mech * PHYSICS_DT

    } else {
      const F_motor  = tau_per * cfg.numMotors * cfg.gearRatio / cfg.spoolRadiusM
      const accel    = (F_motor - cfg.massKg * GRAVITY) / J_eff
      v_elev        += accel * PHYSICS_DT
      y_elev         = Math.max(0, y_elev + v_elev * PHYSICS_DT)
      if (y_elev === 0 && v_elev < 0) v_elev = 0
    }

    // Record at 20 ms
    if (step % RECORD_EVERY === 0) {
      const actualDisplay =
        cfg.type === 'flywheel' ? siToDisplay(omega_mech, cfg) :
        cfg.type === 'arm'      ? siToDisplay(theta_mech, cfg) : y_elev

      points.push({
        time:     parseFloat((timeOffset + t).toFixed(3)),
        setpoint: setpointDisplay,
        actual:   parseFloat(actualDisplay.toFixed(4))
      })
    }
    step++
  }

  // Supress the free-speed warning — freeSpeedRadps is only used via the
  // motor model and not referenced explicitly here.
  void freeSpeedRadps

  const metrics = calculateMetrics(points, setpointDisplay, cfg.type)
  return {
    points,
    finalPhysics: { omega_mech, theta_mech, v_elev, y_elev },
    metrics
  }
}

// ─── Multi-step simulation ────────────────────────────────────────────────────

export interface MultiStepResult {
  points:              StepResponsePoint[]
  segmentBoundaries:   number[]      // time values where setpoint changes
  segmentMetrics:      StepMetrics[]
  aggregateMetrics:    StepMetrics
}

export function runMultiStepSimulation(
  cfg: MechanismConfig,
  gains: Gains,
  steps: TestStep[]
): MultiStepResult {
  if (steps.length === 0) {
    const empty: StepMetrics = { riseTimeS: -1, overshootPct: 0, settlingTimeS: -1, steadyStateError: 0, oscillations: 0, score: 999 }
    return { points: [], segmentBoundaries: [], segmentMetrics: [], aggregateMetrics: empty }
  }

  let physics            = defaultPhysicsState(cfg)
  let timeOffset         = 0
  const allPoints:       StepResponsePoint[] = []
  const segBoundaries:   number[]            = []
  const segMetrics:      StepMetrics[]       = []

  for (const step of steps) {
    const { points, finalPhysics, metrics } = runStep(
      cfg, gains, step.setpointDisplay, step.durationS, physics, timeOffset
    )
    allPoints.push(...points)
    segBoundaries.push(timeOffset)
    segMetrics.push(metrics)
    physics    = { ...finalPhysics, }  // carry state forward (mechanism doesn't reset)
    timeOffset += step.durationS
  }

  return {
    points:           allPoints,
    segmentBoundaries: segBoundaries,
    segmentMetrics:   segMetrics,
    aggregateMetrics: aggregateMetrics(segMetrics, steps, cfg.type)
  }
}

// Backward-compat wrapper used by baseline gain calc and live mode scoring
export function runSimulation(
  cfg: MechanismConfig,
  gains: Gains,
  setpointDisplay: number,
  durationS = 2.0
): { points: StepResponsePoint[]; metrics: StepMetrics } {
  if (durationS <= 0) {
    return { points: [], metrics: { riseTimeS: -1, overshootPct: 0, settlingTimeS: -1, steadyStateError: 0, oscillations: 0, score: 999 } }
  }
  const result = runMultiStepSimulation(cfg, gains, [{ setpointDisplay, durationS }])
  return { points: result.points, metrics: result.aggregateMetrics }
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

function calculateMetrics(
  points: StepResponsePoint[],
  setpoint: number,
  mechType: MechanismType
): StepMetrics {
  if (points.length === 0 || setpoint === 0) {
    return { riseTimeS: -1, overshootPct: 0, settlingTimeS: -1, steadyStateError: 0, oscillations: 0, score: 999 }
  }

  // Segment start time — all time measurements are RELATIVE to this so that
  // later segments in a multi-step run are scored the same as earlier ones.
  const segStartTime = points[0].time

  const startActual = points[0].actual
  const isRampUp    = setpoint >= startActual

  // 10% and 90% thresholds relative to where we started, not from zero
  const delta      = setpoint - startActual
  const thresh10   = startActual + 0.1 * delta
  const thresh90   = startActual + 0.9 * delta
  const band       = 0.02 * Math.abs(setpoint)

  let rise10 = -1, rise90 = -1
  let maxActual = -Infinity, minActual = Infinity
  let settlingTimeAbs = -1

  for (const pt of points) {
    if (pt.actual > maxActual) maxActual = pt.actual
    if (pt.actual < minActual) minActual = pt.actual

    if (isRampUp) {
      if (rise10 < 0 && pt.actual >= thresh10) rise10 = pt.time
      if (rise90 < 0 && pt.actual >= thresh90) rise90 = pt.time
    } else {
      if (rise10 < 0 && pt.actual <= thresh10) rise10 = pt.time
      if (rise90 < 0 && pt.actual <= thresh90) rise90 = pt.time
    }
  }

  for (let i = points.length - 1; i >= 0; i--) {
    if (Math.abs(points[i].actual - setpoint) > band) {
      settlingTimeAbs = i + 1 < points.length ? points[i + 1].time : points[i].time
      break
    }
  }
  // Convert absolute time to time-within-segment. A value of 0 means the system
  // was always within the settling band (settled before the first sample).
  const settlingTime = settlingTimeAbs < 0
    ? 0
    : Math.max(0, settlingTimeAbs - segStartTime)

  // riseTimeS is already relative: rise90 - rise10 are both absolute timestamps
  // so their difference is automatically a duration.
  const riseTimeS = rise90 >= 0 && rise10 >= 0 ? rise90 - rise10 : -1

  // Direction-aware overshoot: how far did we blow past the setpoint?
  const overshootPct = isRampUp
    ? Math.max(0, (maxActual - setpoint) / Math.abs(setpoint) * 100)
    : Math.max(0, (setpoint - minActual) / Math.abs(setpoint) * 100)

  const oscillations = countOscillations(points, setpoint)

  const lastN   = Math.max(1, Math.floor(points.length * 0.2))
  const ssError = points.slice(-lastN).reduce((s, p) => s + Math.abs(p.setpoint - p.actual), 0) / lastN

  const score = computeScore(riseTimeS, overshootPct, settlingTime, ssError, setpoint, oscillations, mechType, isRampUp)

  return { riseTimeS, overshootPct, settlingTimeS: settlingTime, steadyStateError: ssError, oscillations, score }
}

function countOscillations(points: StepResponsePoint[], setpoint: number): number {
  // Count error zero-crossings inside the 20% band, after initial approach
  const band   = 0.20 * Math.abs(setpoint)
  let prevSign = 0
  let settled  = false
  let crossings = 0

  for (const pt of points) {
    const err = pt.actual - setpoint
    // Only start counting once we've gotten within 80% of the setpoint
    if (!settled && Math.abs(err) <= Math.abs(setpoint) * 0.8) settled = true
    if (!settled) continue
    // Only count crossings inside the 20% band (ignores large transient)
    if (Math.abs(err) > band) { prevSign = 0; continue }
    const sign = Math.sign(err) || prevSign
    if (prevSign !== 0 && sign !== prevSign) crossings++
    prevSign = sign
  }
  return crossings
}

function computeScore(
  riseTimeS: number,
  overshootPct: number,
  settlingTimeS: number,
  ssError: number,
  setpoint: number,
  oscillations: number,
  mechType: MechanismType,
  isRampUp: boolean
): number {
  // One zero-crossing after approach is normal underdamped settling — don't penalise.
  // Two or more mean the loop is genuinely hunting.
  const oscPenalty =
    oscillations <= 1 ? 0 :
    oscillations === 2 ? 8 :
    oscillations === 3 ? 25 :
    60 * (oscillations - 2)

  const ssErrPct = Math.abs(setpoint) > 0 ? (ssError / Math.abs(setpoint)) * 100 : ssError

  if (mechType === 'flywheel') {
    if (isRampUp) {
      // Ramp-up: getting to speed fast is everything. Overshoot is fine up to ~15%.
      // Not reaching speed (riseTimeS = -1) is the worst possible outcome.
      const rtPenalty = riseTimeS < 0 ? 90 : riseTimeS * 35
      const ovPenalty =
        overshootPct < 5  ? 0 :                              // free — aggressive is good
        overshootPct < 15 ? (overshootPct - 5) * 0.4 :      // minor cost
        4 + (overshootPct - 15) * 2.5                        // too aggressive
      const stPenalty = settlingTimeS < 0 ? 5 : settlingTimeS * 4
      const ssPenalty = ssErrPct * 2.5   // must actually hold the speed
      return oscPenalty + ovPenalty + rtPenalty + stPenalty + ssPenalty
    } else {
      // Ramp-down: we care that oscillation doesn't happen and speed stabilizes,
      // but fall time and how far it dips below are low stakes.
      const rtPenalty = riseTimeS < 0 ? 3 : riseTimeS * 2
      const ovPenalty = overshootPct * 0.3   // dipping below idle speed is mild
      const stPenalty = settlingTimeS < 0 ? 2 : settlingTimeS * 2
      const ssPenalty = ssErrPct * 0.8
      return oscPenalty + ovPenalty + rtPenalty + stPenalty + ssPenalty
    }
  }

  // ── Position control (arm / elevator) ────────────────────────────────────────
  // Both directions matter equally. Overshoot is more dangerous (physical stops).
  // Settling time weighted highest.
  const ovPenalty =
    overshootPct < 3  ? overshootPct * 0.2 :
    overshootPct < 10 ? 0.6 + (overshootPct - 3) * 2.5 :
    18.1 + (overshootPct - 10) * 5.0
  const rtPenalty  = riseTimeS < 0 ? 60 : riseTimeS * 20
  const stPenalty  = settlingTimeS < 0 ? 40 : settlingTimeS * 15
  const ssPenalty  = ssErrPct * 2.5
  return oscPenalty + ovPenalty + rtPenalty + stPenalty + ssPenalty
}

function aggregateMetrics(segs: StepMetrics[], steps: TestStep[], mechType: MechanismType): StepMetrics {
  if (segs.length === 0) return { riseTimeS: -1, overshootPct: 0, settlingTimeS: -1, steadyStateError: 0, oscillations: 0, score: 999 }

  // For flywheel, ramp-up segments get 3× weight — getting to speed is the primary objective.
  // The first step (from idle) is always a ramp-up and gets full weight.
  const weights = segs.map((_, i) => {
    if (mechType !== 'flywheel') return 1
    if (i === 0) return 3
    return steps[i].setpointDisplay > steps[i - 1].setpointDisplay ? 3 : 1
  })
  const totalW = weights.reduce((s, w) => s + w, 0)
  const wavg = (fn: (m: StepMetrics) => number) =>
    segs.reduce((s, m, i) => s + fn(m) * weights[i], 0) / totalW

  // score=999 is a sentinel for zero-setpoint or empty segments (rise time / settling
  // are undefined at setpoint=0). Exclude them from the score average so that structural
  // zero-RPM steps (start from rest, wind-down) don't inflate the optimizer's objective.
  const scoreWeights = weights.map((w, i) => segs[i].score >= 999 ? 0 : w)
  const totalScoreW  = scoreWeights.reduce((s, w) => s + w, 0)
  const scoreWavg    = totalScoreW > 0
    ? segs.reduce((s, m, i) => s + m.score * scoreWeights[i], 0) / totalScoreW
    : 999

  // riseTimeS display: show the weighted average, but exclude failed (-1) entries
  const validRise = segs.filter((m, i) => m.riseTimeS >= 0).map((m, i) => ({ v: m.riseTimeS, w: weights[segs.indexOf(m)] }))
  const riseTimeS = validRise.length > 0
    ? validRise.reduce((s, x) => s + x.v * x.w, 0) / validRise.reduce((s, x) => s + x.w, 0)
    : -1

  return {
    riseTimeS,
    overshootPct:     wavg(m => m.overshootPct),
    settlingTimeS:    wavg(m => m.settlingTimeS),
    steadyStateError: wavg(m => m.steadyStateError),
    oscillations:     segs.reduce((s, m) => s + m.oscillations, 0),
    score:            scoreWavg,
  }
}

// ─── Progressive test sequences ───────────────────────────────────────────────

// Round a setpoint to a clean display value (avoids 1650.0000000000002 RPM)
function sp(v: number, mechType: MechanismType): number {
  if (mechType === 'flywheel') return Math.round(v)          // nearest RPM
  if (mechType === 'arm')      return Math.round(v * 10) / 10 // 0.1°
  return Math.round(v * 100) / 100                            // 0.01 m
}

export function getTestSequence(
  mechType: MechanismType,
  nominalSetpoint: number,
  expCount: number
): TestStep[] {
  const s = nominalSetpoint
  const S = (v: number) => sp(v, mechType)

  if (mechType === 'flywheel') {
    if (expCount < 3) return [
      { setpointDisplay: S(s),          durationS: 2.0 }
    ]
    if (expCount < 8) return [
      { setpointDisplay: S(s * 0.5),   durationS: 1.0 },
      { setpointDisplay: S(s),          durationS: 2.0 },
    ]
    if (expCount < 15) return [
      { setpointDisplay: S(s * 0.25),  durationS: 0.8 },
      { setpointDisplay: S(s),          durationS: 1.5 },
      { setpointDisplay: S(s * 0.6),   durationS: 1.0 },
      { setpointDisplay: S(s),          durationS: 1.5 },
    ]
    return [
      { setpointDisplay: S(s * 0.25),  durationS: 0.8 },
      { setpointDisplay: S(s * 0.75),  durationS: 1.0 },
      { setpointDisplay: S(s * 0.4),   durationS: 0.7 },
      { setpointDisplay: S(s),          durationS: 1.5 },
      { setpointDisplay: S(s * 0.55),  durationS: 0.8 },
      { setpointDisplay: S(s),          durationS: 1.5 },
    ]
  }

  if (mechType === 'arm') {
    const low = S(Math.max(0, s * 0.05))
    if (expCount < 3) return [
      { setpointDisplay: S(s),          durationS: 2.0 }
    ]
    if (expCount < 8) return [
      { setpointDisplay: S(s),          durationS: 1.5 },
      { setpointDisplay: low,           durationS: 1.0 },
    ]
    if (expCount < 15) return [
      { setpointDisplay: S(s * 0.5),   durationS: 1.0 },
      { setpointDisplay: S(s),          durationS: 1.5 },
      { setpointDisplay: low,           durationS: 1.0 },
      { setpointDisplay: S(s),          durationS: 1.5 },
    ]
    return [
      { setpointDisplay: S(s * 0.3),   durationS: 0.8 },
      { setpointDisplay: S(s * 0.8),   durationS: 1.0 },
      { setpointDisplay: low,           durationS: 0.8 },
      { setpointDisplay: S(s * 0.6),   durationS: 1.0 },
      { setpointDisplay: S(s),          durationS: 1.5 },
      { setpointDisplay: low,           durationS: 0.8 },
    ]
  }

  // elevator
  const low = S(s * 0.05)
  if (expCount < 3) return [
    { setpointDisplay: S(s),            durationS: 2.0 }
  ]
  if (expCount < 8) return [
    { setpointDisplay: S(s),            durationS: 1.5 },
    { setpointDisplay: low,             durationS: 1.0 },
  ]
  if (expCount < 15) return [
    { setpointDisplay: S(s * 0.5),     durationS: 1.0 },
    { setpointDisplay: S(s),            durationS: 1.5 },
    { setpointDisplay: low,             durationS: 1.0 },
    { setpointDisplay: S(s),            durationS: 1.5 },
  ]
  return [
    { setpointDisplay: S(s * 0.2),     durationS: 0.8 },
    { setpointDisplay: S(s * 0.8),     durationS: 1.0 },
    { setpointDisplay: low,             durationS: 0.8 },
    { setpointDisplay: S(s * 0.5),     durationS: 1.0 },
    { setpointDisplay: S(s),            durationS: 1.5 },
    { setpointDisplay: low,             durationS: 0.8 },
  ]
}

export function phaseLabel(expCount: number): string {
  if (expCount < 3)  return 'Phase 1 — single step'
  if (expCount < 8)  return 'Phase 2 — bidirectional'
  if (expCount < 15) return 'Phase 3 — multi-setpoint'
  return 'Phase 4 — full sweep'
}

// ─── Phase 2 sequence generator ───────────────────────────────────────────────
// Generates a fixed test sequence for the fine-tune phase.
// The sequence is evenly spaced between minSP and maxSP with a configurable
// randomization factor. Generated ONCE when Phase 2 starts, then reused for
// all Phase 2 experiments so the GP can compare runs fairly.

export function generatePhase2Sequence(
  mechType: MechanismType,
  minSP: number,
  maxSP: number,
  numSetpoints: number,
  dwellS: number,
  randomization: number
): import('../types').TestStep[] {
  const count = Math.max(2, numSetpoints)
  const range = maxSP - minSP
  const S = (v: number) => sp(v, mechType)
  return Array.from({ length: count }, (_, i) => {
    const base   = minSP + range * (i / (count - 1))
    const jitter = (Math.random() - 0.5) * range * randomization
    const value  = Math.max(minSP, Math.min(maxSP, base + jitter))
    return { setpointDisplay: S(value), durationS: Math.max(0.3, dwellS) }
  })
}

// ─── Phase-progressive sequence generator ────────────────────────────────────
// Generates a fixed test sequence for a given fine-tune phase (2–6).
// Each phase runs a harder, more realistic setpoint pattern.
// Phases 2–5 scale dwell by dwellS; Phase 6 dwells are fixed (match simulation).

export function generatePhaseSequence(
  mechType: MechanismType,
  nominalSetpoint: number,
  phaseNum: number,
  randomization: number
): import('../types').TestStep[] {
  const s = nominalSetpoint
  const S = (v: number) => sp(v, mechType)

  // Per-phase randomization caps
  const randCaps = [0, 0, 0.15, 0.12, 0.10, 0.08, 0.05]
  const rand = Math.min(randomization, randCaps[Math.min(phaseNum, 6)] ?? 0.15)

  function jitter(frac: number, cap: number): number {
    return frac + (Math.random() - 0.5) * 2 * cap * randomization
  }

  if (phaseNum <= 2) {
    // Phase 2: 4-step simple ramp, 1.2s base dwell
    const fracs = [0.25, 0.50, 0.75, 1.00]
    return fracs.map(f => ({
      setpointDisplay: S(s * Math.max(0, Math.min(1.5, jitter(f, rand)))),
      durationS: 1.2,
    }))
  }

  if (phaseNum === 3) {
    // Phase 3: 8-step ramp with dip-and-recover, 1.0s/0.8s dwell
    const steps: [number, number][] = [
      [0.25, 1.0], [0.60, 1.0], [0.45, 0.8], [0.75, 1.0],
      [0.55, 0.8], [0.85, 1.0], [0.70, 0.8], [1.00, 1.0],
    ]
    return steps.map(([f, d]) => ({
      setpointDisplay: S(s * Math.max(0, Math.min(1.5, jitter(f, rand)))),
      durationS: d,
    }))
  }

  if (phaseNum === 4) {
    // Phase 4: 16-step aggressive mixed up/down, 0.8s/0.65s dwell
    const steps: [number, number][] = [
      [0.20, 0.65], [1.00, 0.8],  [0.30, 0.65], [0.80, 0.8],
      [0.50, 0.8],  [1.00, 0.8],  [0.40, 0.65], [0.70, 0.8],
      [0.90, 0.8],  [0.60, 0.8],  [1.00, 0.8],  [0.25, 0.65],
      [0.85, 0.8],  [0.55, 0.8],  [0.95, 0.8],  [1.00, 0.8],
    ]
    return steps.map(([f, d]) => ({
      setpointDisplay: S(s * Math.max(0, Math.min(1.5, jitter(f, rand)))),
      durationS: d,
    }))
  }

  if (phaseNum === 5) {
    // Phase 5: 30-step stress test — max→0→max cycles, 0.6s/0.5s dwell
    const steps: [number, number][] = [
      // cold start
      [0.00, 0.5], [1.00, 0.6],
      // first max→zero→max cycle
      [0.00, 0.5], [1.00, 0.6], [0.00, 0.5], [1.00, 0.6],
      // mid-range chaos
      [0.40, 0.6], [1.00, 0.6], [0.60, 0.6], [0.00, 0.5], [0.80, 0.6], [1.00, 0.6],
      // second zero cycle with intermediates
      [0.00, 0.5], [0.50, 0.6], [1.00, 0.6], [0.00, 0.5], [0.70, 0.6], [1.00, 0.6],
      // descending staircase
      [0.80, 0.6], [0.60, 0.6], [0.40, 0.6], [0.20, 0.6], [0.00, 0.5],
      // final ramp
      [1.00, 0.6], [0.00, 0.5], [1.00, 0.6], [0.00, 0.5], [1.00, 0.6],
      // hold
      [1.00, 0.6], [0.00, 0.5],
    ]
    // Don't jitter zero-fraction steps — jitter on f=0 creates tiny near-zero targets
    // (e.g. 7 RPM) where overshoot% becomes meaningless (64% = 4 RPM past a 7 RPM target).
    return steps.map(([f, d]) => ({
      setpointDisplay: f === 0 ? S(0) : S(s * Math.max(0, Math.min(1.5, jitter(f, rand)))),
      durationS: d,
    }))
  }

  // Phase 6: ~75-step 2-minute match simulation — fixed dwells, no dwellS scaling
  // Shooting-on-the-move sections use structural setpoint variation (not random jitter).
  const p6Steps: [number, number][] = [
    // AUTO PERIOD (~15s): spin-up, 3 shots, drive away
    [0.00, 0.8],  [1.00, 1.5],  [0.85, 0.6], [1.00, 0.6], [0.85, 0.6],
    [1.00, 0.6],  [0.85, 0.6],  [1.00, 0.8], [0.15, 2.0],
    // EARLY TELEOP SHOTS (~20s): fixed-position shot cluster
    [1.00, 0.8],  [0.85, 0.5],  [1.00, 0.6], [0.85, 0.5], [1.00, 0.6],
    [0.85, 0.5],  [1.00, 0.6],  [0.85, 0.5], [1.00, 0.8], [0.20, 1.5],
    // SHOOTING ON THE MOVE 1 (~15s): camera-correction jitter — structural, not random
    [0.95, 0.5],  [0.88, 0.4],  [1.00, 0.5], [0.92, 0.4], [0.98, 0.5],
    [0.86, 0.4],  [1.00, 0.5],  [0.90, 0.4], [0.97, 0.5], [0.84, 0.4],
    [1.00, 0.5],  [0.93, 0.4],  [0.88, 0.5], [1.00, 0.5], [0.15, 1.5],
    // MID-MATCH REPOSITIONING (~15s)
    [0.15, 3.0],  [1.00, 0.8],  [0.85, 0.5], [1.00, 0.6], [0.85, 0.5],
    [1.00, 0.6],  [0.20, 3.0],
    // SHOOTING ON THE MOVE 2 (~15s)
    [0.90, 0.5],  [1.00, 0.4],  [0.87, 0.5], [0.97, 0.4], [1.00, 0.5],
    [0.91, 0.4],  [0.85, 0.5],  [1.00, 0.4], [0.93, 0.5], [0.88, 0.4],
    [1.00, 0.5],  [0.95, 0.5],  [0.20, 1.5],
    // LATE-MATCH PUSH (~20s): urgent full-power shots
    [1.00, 1.0],  [0.85, 0.5],  [1.00, 0.6], [0.85, 0.5], [1.00, 0.6],
    [0.85, 0.5],  [1.00, 0.6],  [0.85, 0.5], [1.00, 0.6], [0.85, 0.5],
    [1.00, 0.6],  [0.85, 0.5],  [1.00, 1.0],
    // WIND-DOWN (~10s)
    [0.50, 2.0],  [0.25, 2.0],  [0.00, 3.0],
  ]
  return p6Steps.map(([f, d]) => ({
    setpointDisplay: S(s * f),
    durationS: d,
  }))
}

// ─── Display unit label ───────────────────────────────────────────────────────

export function displayUnitLabel(cfg: MechanismConfig): string {
  if (cfg.type === 'flywheel') return 'RPM'
  if (cfg.type === 'arm')      return '°'
  return 'm'
}

export function defaultSetpoint(cfg: MechanismConfig): number {
  if (cfg.type === 'flywheel') return 3000
  if (cfg.type === 'arm')      return 45
  return 1.0
}

// ─── Baseline gain calculator ─────────────────────────────────────────────────

export function calculateBaselineGains(cfg: MechanismConfig): import('../types').Gains {
  const motor  = MOTORS[cfg.motorType]
  const kV     = motorKvCTRE(motor)

  let J_mech: number
  if      (cfg.type === 'flywheel') J_mech = 0.5 * cfg.massKg * cfg.radiusM ** 2
  else if (cfg.type === 'arm')      J_mech = (1 / 3) * cfg.massKg * cfg.lengthM ** 2
  else                              J_mech = cfg.massKg * cfg.spoolRadiusM ** 2

  const J_motor  = cfg.numMotors * motor.rotorInertiaKgM2 * cfg.gearRatio ** 2
  const J_total  = J_mech + J_motor

  // kA: voltage per (RPS/s of rotor acceleration)
  const kA = J_total * motor.resistanceOhms * 2 * Math.PI /
    (motor.KtNmPerAmp * cfg.numMotors * cfg.gearRatio ** 2)

  let kG = 0
  if (cfg.type === 'arm') {
    kG = cfg.massKg * GRAVITY * (cfg.lengthM / 2) * motor.resistanceOhms /
      (motor.KtNmPerAmp * cfg.numMotors * cfg.gearRatio)
  } else if (cfg.type === 'elevator') {
    kG = cfg.massKg * GRAVITY * cfg.spoolRadiusM * motor.resistanceOhms /
      (motor.KtNmPerAmp * cfg.numMotors * cfg.gearRatio)
  }

  return {
    kP: cfg.type === 'flywheel' ? 0.05 : 1.0,
    kI: 0,
    kD: 0,
    kS: 0.25,
    kV: parseFloat(kV.toFixed(4)),
    kA: parseFloat(kA.toFixed(4)),
    kG: parseFloat(kG.toFixed(4)),
  }
}
