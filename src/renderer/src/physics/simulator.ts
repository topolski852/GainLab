import { MechanismConfig, Gains, StepResponsePoint, StepMetrics, TestStep, MechanismType, StressDiagnostics, SegmentDiagnostic, StressThresholds } from '../types'
import { MOTORS, motorKvCTRE } from './motors'

const PHYSICS_DT = 0.005
const PID_DT     = 0.020
const SUPPLY_V   = 12.0
const GRAVITY    = 9.81

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Flywheel and roller share the same physics model (spinning wheel, J = ½mr²,
// velocity control in RPM). The only difference is inertia — rollers are lighter.
function isRotary(type: MechanismType): boolean {
  return type === 'flywheel' || type === 'roller'
}

// ─── Unit conversions ─────────────────────────────────────────────────────────
// Simulation state is always SI (rad/s, rad, m/s, m).
// Gains live in CTRE Phoenix 6 rotor units (RPS, rotations).
// Display units are natural (RPM, deg, m) for readability.

function displayToSI(v: number, cfg: MechanismConfig): number {
  if (isRotary(cfg.type)) return v * 2 * Math.PI / (60 * cfg.gearRatio)  // RPM → mech rad/s
  if (cfg.type === 'arm')  return v * Math.PI / 180                        // deg → rad
  return v                                                                  // elevator: m
}

function siToDisplay(v: number, cfg: MechanismConfig): number {
  if (isRotary(cfg.type)) return v * cfg.gearRatio * 60 / (2 * Math.PI)  // mech rad/s → RPM
  if (cfg.type === 'arm')  return v * 180 / Math.PI                        // rad → deg
  return v
}

function siToCTRE(v: number, cfg: MechanismConfig): number {
  if (isRotary(cfg.type)) return v * cfg.gearRatio / (2 * Math.PI)
  if (cfg.type === 'arm')  return v * cfg.gearRatio / (2 * Math.PI)
  return v * cfg.gearRatio / (2 * Math.PI * cfg.spoolRadiusM)
}

function displayToCTRE(v: number, cfg: MechanismConfig): number {
  return siToCTRE(displayToSI(v, cfg), cfg)
}

// ─── Physics state ────────────────────────────────────────────────────────────

interface PhysicsState {
  omega_mech: number   // rad/s at mechanism (rotary velocity; arm/elevator angular rate)
  theta_mech: number   // rad (arm position; unused for rotary)
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
  const motor  = MOTORS[cfg.motorType]
  const J_motor = cfg.numMotors * motor.rotorInertiaKgM2 * cfg.gearRatio ** 2

  if (isRotary(cfg.type)) {
    // Both flywheel and roller: solid disk/cylinder approximation J = ½mr²
    return 0.5 * cfg.massKg * cfg.radiusM ** 2 + J_motor
  }
  if (cfg.type === 'arm') {
    return (1 / 3) * cfg.massKg * cfg.lengthM ** 2 + J_motor
  }
  // elevator: linear mass + motor inertia reflected through spool
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

  const initActualCTRE = siToCTRE(
    isRotary(cfg.type) ? omega_mech :
    cfg.type === 'arm' ? theta_mech : y_elev,
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
      const actualCTRE = isRotary(cfg.type)
        ? siToCTRE(omega_mech, cfg)
        : cfg.type === 'arm'
          ? siToCTRE(theta_mech, cfg)
          : siToCTRE(y_elev, cfg)

      const error  = setpointCTRE - actualCTRE
      integral    += error * PID_DT
      integral     = Math.max(-50, Math.min(50, integral))

      // For position-controlled mechanisms, derive from actual velocity instead of
      // error finite-difference. The 20ms sample rate makes finite-diff kD numerically
      // unstable at high gear ratios (kD_max ≈ J×R / (Kt×n×G²×T) ≈ 0.02 for G=100).
      // Velocity-based kD is how Phoenix 6 applies it internally (measurement-on-output).
      let deriv: number
      if (cfg.type === 'arm') {
        deriv = -omega_mech * cfg.gearRatio / (2 * Math.PI)
      } else if (cfg.type === 'elevator') {
        deriv = -v_elev * cfg.gearRatio / (2 * Math.PI * cfg.spoolRadiusM)
      } else {
        deriv = (error - prevError) / PID_DT
      }
      prevError    = error

      // For position-controlled mechanisms (arm/elevator), Phoenix 6 PositionVoltage
      // applies kS and kV using the motion-profile velocity setpoint, which is zero for
      // a static step. Using actual velocity here is anti-damping (velocity in the
      // direction of motion adds energy to oscillations). Only kG is applied; kS/kV
      // are forced to 0 in the optimizer bounds for arm/elevator.
      let ff: number
      if (cfg.type === 'arm') {
        ff = gains.kG * Math.cos(theta_mech)
      } else if (cfg.type === 'elevator') {
        ff = gains.kG
      } else {
        ff = gains.kS * Math.sign(setpointCTRE) + gains.kV * setpointCTRE
      }

      voltage  = gains.kP * error + gains.kI * integral + gains.kD * deriv + ff
      voltage  = Math.max(-SUPPLY_V, Math.min(SUPPLY_V, voltage))
      pidTimer = 0
    }
    pidTimer += PHYSICS_DT

    // Motor physics (5 ms)
    const omega_rotor = cfg.type === 'elevator'
      ? (v_elev / cfg.spoolRadiusM) * cfg.gearRatio
      : omega_mech * cfg.gearRatio

    const v_bemf  = omega_rotor / motor.KvRadPerSecPerVolt
    const current = Math.max(-motor.stallCurrentA,
                      Math.min(motor.stallCurrentA,
                        (voltage - v_bemf) / motor.resistanceOhms))
    const tau_per = current * motor.KtNmPerAmp

    if (isRotary(cfg.type)) {
      omega_mech += (tau_per * cfg.numMotors * cfg.gearRatio / J_eff) * PHYSICS_DT

    } else if (cfg.type === 'arm') {
      const cgDist   = cfg.cgDistanceM ?? cfg.lengthM / 2
      const tau_grav = cfg.massKg * GRAVITY * cgDist * Math.cos(theta_mech)
      const alpha    = (tau_per * cfg.numMotors * cfg.gearRatio - tau_grav) / J_eff
      omega_mech    += alpha * PHYSICS_DT
      theta_mech    += omega_mech * PHYSICS_DT

    } else {
      const F_motor = tau_per * cfg.numMotors * cfg.gearRatio / cfg.spoolRadiusM
      const accel   = (F_motor - cfg.massKg * GRAVITY) / J_eff
      v_elev       += accel * PHYSICS_DT
      y_elev        = Math.max(0, y_elev + v_elev * PHYSICS_DT)
      if (y_elev === 0 && v_elev < 0) v_elev = 0
    }

    // Record at 20 ms
    if (step % RECORD_EVERY === 0) {
      const actualDisplay = isRotary(cfg.type)
        ? siToDisplay(omega_mech, cfg)
        : cfg.type === 'arm'
          ? siToDisplay(theta_mech, cfg)
          : y_elev

      points.push({
        time:     parseFloat((timeOffset + t).toFixed(3)),
        setpoint: setpointDisplay,
        actual:   parseFloat(actualDisplay.toFixed(4))
      })
    }
    step++
  }

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
  segmentBoundaries:   number[]
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

  let physics          = defaultPhysicsState(cfg)
  let timeOffset       = 0
  const allPoints:     StepResponsePoint[] = []
  const segBoundaries: number[]            = []
  const segMetrics:    StepMetrics[]       = []

  for (const step of steps) {
    const { points, finalPhysics, metrics } = runStep(
      cfg, gains, step.setpointDisplay, step.durationS, physics, timeOffset
    )
    allPoints.push(...points)
    segBoundaries.push(timeOffset)
    segMetrics.push(metrics)
    physics    = { ...finalPhysics }
    timeOffset += step.durationS
  }

  return {
    points:            allPoints,
    segmentBoundaries: segBoundaries,
    segmentMetrics:    segMetrics,
    aggregateMetrics:  aggregateMetrics(segMetrics, steps, cfg.type)
  }
}

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

  const segStartTime = points[0].time
  const startActual  = points[0].actual
  const isRampUp     = setpoint >= startActual

  const delta    = setpoint - startActual
  const thresh10 = startActual + 0.1 * delta
  const thresh90 = startActual + 0.9 * delta
  // Position mechanisms use a wider settling band: FRC arms/elevators don't need
  // sub-2% precision to be "settled" — ±5% for arm, ±3% for elevator.
  const bandFrac  = mechType === 'arm' ? 0.05 : mechType === 'elevator' ? 0.03 : 0.02
  const band      = bandFrac * Math.abs(setpoint)

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
  const settlingTime = settlingTimeAbs < 0
    ? 0
    : Math.max(0, settlingTimeAbs - segStartTime)

  const riseTimeS = rise90 >= 0 && rise10 >= 0 ? rise90 - rise10 : -1

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
  const band   = 0.20 * Math.abs(setpoint)
  let prevSign = 0
  let settled  = false
  let crossings = 0

  for (const pt of points) {
    const err = pt.actual - setpoint
    if (!settled && Math.abs(err) <= Math.abs(setpoint) * 0.8) settled = true
    if (!settled) continue
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
  const oscPenalty =
    oscillations <= 1 ? 0 :
    oscillations === 2 ? 8 :
    oscillations === 3 ? 25 :
    60 * (oscillations - 2)

  const ssErrPct = Math.abs(setpoint) > 0 ? (ssError / Math.abs(setpoint)) * 100 : ssError

  if (mechType === 'flywheel') {
    // Flywheel: get to speed fast, hold it. Moderate overshoot is fine.
    if (isRampUp) {
      const rtPenalty = riseTimeS < 0 ? 90 : riseTimeS * 35
      const ovPenalty =
        overshootPct < 5  ? 0 :
        overshootPct < 15 ? (overshootPct - 5) * 0.4 :
        4 + (overshootPct - 15) * 2.5
      const stPenalty = settlingTimeS < 0 ? 5 : settlingTimeS * 4
      const ssPenalty = ssErrPct * 2.5
      return oscPenalty + ovPenalty + rtPenalty + stPenalty + ssPenalty
    } else {
      const rtPenalty = riseTimeS < 0 ? 3 : riseTimeS * 2
      const ovPenalty = overshootPct * 0.3
      const stPenalty = settlingTimeS < 0 ? 2 : settlingTimeS * 2
      const ssPenalty = ssErrPct * 0.8
      return oscPenalty + ovPenalty + rtPenalty + stPenalty + ssPenalty
    }
  }

  if (mechType === 'roller') {
    // Roller: consistent speed under varying load matters more than raw ramp speed.
    // Moderate overshoot is acceptable; steady-state error and oscillation cost more
    // because a hunting roller loses grip consistency on game pieces.
    if (isRampUp) {
      const rtPenalty = riseTimeS < 0 ? 70 : riseTimeS * 25
      const ovPenalty =
        overshootPct < 8  ? 0 :
        overshootPct < 20 ? (overshootPct - 8) * 0.8 :
        9.6 + (overshootPct - 20) * 3.0
      const stPenalty = settlingTimeS < 0 ? 8 : settlingTimeS * 6
      const ssPenalty = ssErrPct * 4.0   // holding speed under game-piece load matters
      return oscPenalty + ovPenalty + rtPenalty + stPenalty + ssPenalty
    } else {
      const rtPenalty = riseTimeS < 0 ? 4 : riseTimeS * 3
      const ovPenalty = overshootPct * 0.5
      const stPenalty = settlingTimeS < 0 ? 3 : settlingTimeS * 3
      const ssPenalty = ssErrPct * 1.5
      return oscPenalty + ovPenalty + rtPenalty + stPenalty + ssPenalty
    }
  }

  // ── Position control (arm / elevator) ────────────────────────────────────────
  // Overshoot is dangerous (physical stops) — keep aggressive.
  // Rise/settle coefficients are gentler than flywheel: a 200ms rise on a 90° arm
  // move is excellent FRC performance, not a 4-point penalty.
  const ovPenalty =
    overshootPct < 3  ? overshootPct * 0.2 :
    overshootPct < 10 ? 0.6 + (overshootPct - 3) * 2.5 :
    18.1 + (overshootPct - 10) * 5.0
  const rtPenalty = riseTimeS < 0 ? 60 : riseTimeS * 12
  const stPenalty = settlingTimeS < 0 ? 40 : settlingTimeS * 6
  // Scale tolerance with setpoint so stow-position noise (0.07° on a 2.25° stow)
  // stays free while meaningful deploy error (1°+ on a 44°+ move) gets penalized.
  // Floor (0.2°) protects tiny stow positions; ceiling (0.8°) keeps large setpoints honest.
  const absTol = mechType === 'arm'
    ? Math.min(0.8, Math.max(0.2, Math.abs(setpoint) * 0.015))
    : 0.02
  const ssErrAdj = Math.max(0, ssError - absTol)
  const ssErrAdjPct = Math.abs(setpoint) > absTol
    ? (ssErrAdj / Math.abs(setpoint)) * 100
    : ssErrAdj * 100
  const ssPenalty = ssErrAdjPct * 2.5
  return oscPenalty + ovPenalty + rtPenalty + stPenalty + ssPenalty
}

function aggregateMetrics(segs: StepMetrics[], steps: TestStep[], mechType: MechanismType): StepMetrics {
  if (segs.length === 0) return { riseTimeS: -1, overshootPct: 0, settlingTimeS: -1, steadyStateError: 0, oscillations: 0, score: 999 }

  // For rotary mechanisms (flywheel/roller), ramp-up segments get 3× weight.
  const weights = segs.map((_, i) => {
    if (!isRotary(mechType)) return 1
    if (i === 0) return 3
    return steps[i].setpointDisplay > steps[i - 1].setpointDisplay ? 3 : 1
  })
  const totalW = weights.reduce((s, w) => s + w, 0)
  const wavg = (fn: (m: StepMetrics) => number) =>
    segs.reduce((s, m, i) => s + fn(m) * weights[i], 0) / totalW

  const scoreWeights = weights.map((w, i) => segs[i].score >= 999 ? 0 : w)
  const totalScoreW  = scoreWeights.reduce((s, w) => s + w, 0)
  const scoreWavg    = totalScoreW > 0
    ? segs.reduce((s, m, i) => s + m.score * scoreWeights[i], 0) / totalScoreW
    : 999

  const validRise = segs.filter(m => m.riseTimeS >= 0).map((m, i) => ({ v: m.riseTimeS, w: weights[segs.indexOf(m)] }))
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

function sp(v: number, mechType: MechanismType): number {
  if (isRotary(mechType)) return Math.round(v)           // nearest RPM
  if (mechType === 'arm') return Math.round(v * 10) / 10 // 0.1°
  return Math.round(v * 100) / 100                        // 0.01 m
}

export function getTestSequence(
  mechType: MechanismType,
  nominalSetpoint: number,
  expCount: number
): TestStep[] {
  const s = nominalSetpoint
  const S = (v: number) => sp(v, mechType)

  if (isRotary(mechType)) {
    if (expCount < 3) return [
      { setpointDisplay: S(s),         durationS: 2.0 }
    ]
    if (expCount < 8) return [
      { setpointDisplay: S(s * 0.5),  durationS: 1.0 },
      { setpointDisplay: S(s),         durationS: 2.0 },
    ]
    if (expCount < 15) return [
      { setpointDisplay: S(s * 0.25), durationS: 0.8 },
      { setpointDisplay: S(s),         durationS: 1.5 },
      { setpointDisplay: S(s * 0.6),  durationS: 1.0 },
      { setpointDisplay: S(s),         durationS: 1.5 },
    ]
    return [
      { setpointDisplay: S(s * 0.25), durationS: 0.8 },
      { setpointDisplay: S(s * 0.75), durationS: 1.0 },
      { setpointDisplay: S(s * 0.4),  durationS: 0.7 },
      { setpointDisplay: S(s),         durationS: 1.5 },
      { setpointDisplay: S(s * 0.55), durationS: 0.8 },
      { setpointDisplay: S(s),         durationS: 1.5 },
    ]
  }

  if (mechType === 'arm') {
    const low = S(Math.max(0, s * 0.05))
    if (expCount < 3) return [
      { setpointDisplay: S(s),         durationS: 2.0 }
    ]
    if (expCount < 8) return [
      { setpointDisplay: S(s),         durationS: 1.5 },
      { setpointDisplay: low,          durationS: 1.0 },
    ]
    if (expCount < 15) return [
      { setpointDisplay: S(s * 0.5),  durationS: 1.0 },
      { setpointDisplay: S(s),         durationS: 1.5 },
      { setpointDisplay: low,          durationS: 1.0 },
      { setpointDisplay: S(s),         durationS: 1.5 },
    ]
    return [
      { setpointDisplay: S(s * 0.3),  durationS: 0.8 },
      { setpointDisplay: S(s * 0.8),  durationS: 1.0 },
      { setpointDisplay: low,          durationS: 0.8 },
      { setpointDisplay: S(s * 0.6),  durationS: 1.0 },
      { setpointDisplay: S(s),         durationS: 1.5 },
      { setpointDisplay: low,          durationS: 0.8 },
    ]
  }

  // elevator
  const low = S(s * 0.05)
  if (expCount < 3) return [
    { setpointDisplay: S(s),           durationS: 2.0 }
  ]
  if (expCount < 8) return [
    { setpointDisplay: S(s),           durationS: 1.5 },
    { setpointDisplay: low,            durationS: 1.0 },
  ]
  if (expCount < 15) return [
    { setpointDisplay: S(s * 0.5),    durationS: 1.0 },
    { setpointDisplay: S(s),           durationS: 1.5 },
    { setpointDisplay: low,            durationS: 1.0 },
    { setpointDisplay: S(s),           durationS: 1.5 },
  ]
  return [
    { setpointDisplay: S(s * 0.2),    durationS: 0.8 },
    { setpointDisplay: S(s * 0.8),    durationS: 1.0 },
    { setpointDisplay: low,            durationS: 0.8 },
    { setpointDisplay: S(s * 0.5),    durationS: 1.0 },
    { setpointDisplay: S(s),           durationS: 1.5 },
    { setpointDisplay: low,            durationS: 0.8 },
  ]
}

export function phaseLabel(expCount: number): string {
  if (expCount < 3)  return 'Phase 1 — single step'
  if (expCount < 8)  return 'Phase 2 — bidirectional'
  if (expCount < 15) return 'Phase 3 — multi-setpoint'
  return 'Phase 4 — full sweep'
}

// ─── Phase 2 sequence generator ───────────────────────────────────────────────

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

export function generatePhaseSequence(
  mechType: MechanismType,
  nominalSetpoint: number,
  phaseNum: number,
  randomization: number
): import('../types').TestStep[] {
  const s = nominalSetpoint
  const S = (v: number) => sp(v, mechType)

  const randCaps = [0, 0, 0.15, 0.12, 0.10, 0.08, 0, 0]
  const rand = Math.min(randomization, randCaps[Math.min(phaseNum, 7)] ?? 0.15)

  // Fractions < 0.10 represent stow/home positions and are never jittered.
  function jit(frac: number): number {
    if (frac < 0.10) return frac
    return Math.max(0.05, Math.min(1.5, frac + (Math.random() - 0.5) * 2 * rand * randomization))
  }

  // ── Position control: Arm & Elevator ─────────────────────────────────────────
  // All phases use deploy/stow cycles. Rotary ramp sequences don't apply here
  // because position mechanisms move between defined points, not speed sweeps.
  if (mechType === 'arm' || mechType === 'elevator') {
    const P = (frac: number, dur: number): import('../types').TestStep =>
      ({ setpointDisplay: S(s * jit(frac)), durationS: dur })

    if (phaseNum <= 2) {
      // Basic stow → deploy cycles. Establishes whether gains can reach the target
      // in both directions before the optimizer narrows the search space.
      return [
        P(0.05, 1.2), P(1.00, 1.5),
        P(0.05, 1.2), P(1.00, 1.5),
      ]
    }

    if (phaseNum === 3) {
      // Graduated deploy targets with stow returns. Verifies gains handle partial
      // moves (60%, 80%) as well as full deploy — common in multi-position mechanisms.
      return [
        P(0.05, 1.0), P(0.60, 1.2),
        P(0.05, 1.0), P(0.80, 1.2),
        P(0.05, 1.0), P(1.00, 1.5),
        P(0.05, 1.0), P(1.00, 1.5),
      ]
    }

    if (phaseNum === 4) {
      // Non-sequential heights: tests re-targeting from arbitrary positions,
      // not just stow→full. Mixed dwell times stress settling at each height.
      return [
        P(0.05, 0.8), P(1.00, 1.2),
        P(0.05, 0.8), P(0.40, 1.0),
        P(0.05, 0.8), P(0.70, 1.0),
        P(0.05, 0.8), P(1.00, 1.2),
        P(0.05, 0.8), P(0.60, 1.0),
        P(0.05, 0.8), P(1.00, 1.2),
        P(0.05, 0.8), P(0.80, 1.0),
        P(0.05, 0.8), P(1.00, 1.0),
      ]
    }

    if (phaseNum === 5) {
      // Fast full-range cycles with varied intermediate targets. Short dwells expose
      // gains that are too slow or oscillate before settling within the window.
      return [
        P(0.05, 0.5), P(1.00, 0.8),
        P(0.05, 0.5), P(1.00, 0.8),
        P(0.05, 0.5), P(0.50, 0.7),
        P(0.05, 0.5), P(1.00, 0.8),
        P(0.05, 0.5), P(1.00, 0.8),
        P(0.05, 0.5), P(0.75, 0.7),
        P(0.05, 0.5), P(1.00, 0.8),
        P(0.05, 0.5), P(0.30, 0.7),
        P(0.05, 0.5), P(0.90, 0.8),
        P(0.05, 0.5), P(1.00, 0.8),
        P(0.05, 0.5), P(1.00, 0.8),
        P(0.05, 0.5), P(1.00, 0.8),
      ]
    }

    // Structural fixed sequences — no jitter applied.
    const M = (frac: number, dur: number): import('../types').TestStep =>
      ({ setpointDisplay: S(s * frac), durationS: dur })

    if (phaseNum === 6) {
      // Phase 6: stress diagnostics — single fixed run, aggressive drop cycles.
      // Sudden full-range reversals from arbitrary positions stress kP/kD/kG interaction.
      return mechType === 'arm'
        ? [
            M(0.05, 0.5), M(1.00, 0.8),
            M(0.05, 0.5), M(1.00, 0.8),
            M(0.05, 0.5), M(0.50, 0.8),
            M(1.00, 0.8), M(0.05, 0.5),
            M(1.00, 0.8), M(0.05, 0.5),
            M(0.75, 0.7), M(0.05, 0.5),
            M(1.00, 0.8), M(0.50, 0.7),
            M(0.05, 0.5), M(1.00, 0.8),
            M(0.30, 0.6), M(1.00, 0.8),
            M(0.05, 0.5), M(1.00, 0.8),
          ]
        : [
            // Elevator: L4→stow→L4 rapid cycles, mixed L2/L3 drops
            M(0.05, 0.5), M(1.00, 0.8),
            M(0.05, 0.5), M(1.00, 0.8),
            M(0.05, 0.5), M(0.65, 0.8),
            M(1.00, 0.8), M(0.05, 0.5),
            M(1.00, 0.8), M(0.05, 0.5),
            M(0.35, 0.7), M(0.05, 0.5),
            M(1.00, 0.8), M(0.35, 0.7),
            M(0.05, 0.5), M(1.00, 0.8),
            M(0.65, 0.7), M(1.00, 0.8),
            M(0.05, 0.5), M(1.00, 0.8),
          ]
    }

    // Phase 7: match benchmark — full match simulation.
    // Setpoints are structural (real match motion) — no jitter applied.

    if (mechType === 'arm') {
      // Arm Phase 7 match benchmark: deploy/stow cycles with defense posture and end-game hold.
      return [
        // AUTO: 2 scoring cycles
        M(0.05, 0.5), M(1.00, 1.5), M(0.05, 0.8), M(1.00, 1.5), M(0.05, 1.0),
        // EARLY TELEOP: intake/score rhythm
        M(1.00, 1.2), M(0.05, 0.8), M(1.00, 1.2), M(0.05, 0.8),
        M(1.00, 1.2), M(0.05, 0.8), M(1.00, 1.2), M(0.05, 1.5),
        // DEFENSE: arm tucked low while robot takes hits
        M(0.20, 2.5),
        // RESUME SCORING
        M(1.00, 1.0), M(0.05, 0.7), M(1.00, 1.0), M(0.05, 0.7),
        // PARTIAL DEPLOY: mid-height play (climb-over defense, partial intake)
        M(0.50, 1.5), M(1.00, 1.0), M(0.05, 0.8),
        // LATE MATCH: fast scoring sprint
        M(1.00, 1.0), M(0.05, 0.6), M(1.00, 1.0), M(0.05, 0.6),
        M(1.00, 1.0), M(0.05, 0.6), M(1.00, 1.0), M(0.05, 0.8),
        // END-GAME: hold deployed for climb/trap, then stow
        M(0.80, 3.5), M(0.05, 2.0),
      ]
    }

    // Elevator Phase 7 match benchmark: L2/L3/L4 scoring height cycles.
    return [
      // AUTO: 2 high-goal cycles
      M(0.05, 0.5), M(1.00, 1.5), M(0.05, 0.8), M(1.00, 1.5), M(0.05, 0.8),
      // EARLY TELEOP: mixed L3/L4
      M(1.00, 1.2), M(0.05, 0.8), M(0.65, 1.0), M(0.05, 0.8),
      M(1.00, 1.2), M(0.05, 0.8), M(0.65, 1.0), M(0.05, 1.5),
      // LOW SCORING: L2 rapid cycles
      M(0.35, 1.0), M(0.05, 0.6), M(0.35, 1.0), M(0.05, 0.6),
      M(0.35, 1.0), M(0.05, 1.0),
      // REPOSITIONING
      M(0.05, 2.0),
      // MIXED HEIGHTS
      M(0.65, 1.2), M(0.05, 0.8), M(0.35, 1.0), M(0.05, 0.8),
      M(1.00, 1.2), M(0.05, 0.8), M(0.65, 1.0), M(0.05, 0.8),
      // LATE MATCH: L4 push for max points
      M(1.00, 1.2), M(0.05, 0.8), M(1.00, 1.2), M(0.05, 0.8),
      // END-GAME: hold high for climb, then lower safely
      M(0.85, 4.0), M(0.05, 2.0),
    ]
  }

  // ── Rotary: Flywheel & Roller (velocity control) ─────────────────────────────
  // Phases 2–5 use speed ramp and sweep sequences.

  if (phaseNum <= 2) {
    return [0.25, 0.50, 0.75, 1.00].map(f => ({
      setpointDisplay: S(s * jit(f)),
      durationS: 1.2,
    }))
  }

  if (phaseNum === 3) {
    const s3: [number, number][] = [
      [0.25, 1.0], [0.60, 1.0], [0.45, 0.8], [0.75, 1.0],
      [0.55, 0.8], [0.85, 1.0], [0.70, 0.8], [1.00, 1.0],
    ]
    return s3.map(([f, d]) => ({ setpointDisplay: S(s * jit(f)), durationS: d }))
  }

  if (phaseNum === 4) {
    const s4: [number, number][] = [
      [0.20, 0.65], [1.00, 0.8],  [0.30, 0.65], [0.80, 0.8],
      [0.50, 0.8],  [1.00, 0.8],  [0.40, 0.65], [0.70, 0.8],
      [0.90, 0.8],  [0.60, 0.8],  [1.00, 0.8],  [0.25, 0.65],
      [0.85, 0.8],  [0.55, 0.8],  [0.95, 0.8],  [1.00, 0.8],
    ]
    return s4.map(([f, d]) => ({ setpointDisplay: S(s * jit(f)), durationS: d }))
  }

  if (phaseNum === 5) {
    // Clean tight optimization — no zero-RPM drops. Keeps optimizer signal consistent
    // so the GP can converge reliably in the ±2.5% radius before stress testing.
    const s5: [number, number][] = [
      [0.25, 0.7], [0.90, 0.7], [0.40, 0.7], [1.00, 0.7],
      [0.55, 0.7], [0.95, 0.7], [0.35, 0.55], [0.80, 0.7],
      [0.70, 0.7], [0.45, 0.55], [1.00, 0.7], [0.30, 0.55],
      [0.85, 0.7], [0.60, 0.7], [0.95, 0.7], [0.50, 0.55],
      [0.75, 0.7], [0.90, 0.7], [0.65, 0.7], [1.00, 0.7],
    ]
    return s5.map(([f, d]) => ({ setpointDisplay: S(s * jit(f)), durationS: d }))
  }

  if (phaseNum === 6) {
    // Phase 6: stress diagnostics — single fixed run, zero-RPM drop cycles.
    // No randomization; structural zero drops are the designed test signal.
    const s6: [number, number][] = [
      [0.00, 0.5], [1.00, 0.6],
      [0.00, 0.5], [1.00, 0.6], [0.00, 0.5], [1.00, 0.6],
      [0.40, 0.6], [1.00, 0.6], [0.60, 0.6], [0.00, 0.5], [0.80, 0.6], [1.00, 0.6],
      [0.00, 0.5], [0.50, 0.6], [1.00, 0.6], [0.00, 0.5], [0.70, 0.6], [1.00, 0.6],
      [0.80, 0.6], [0.60, 0.6], [0.40, 0.6], [0.20, 0.6], [0.00, 0.5],
      [1.00, 0.6], [0.00, 0.5], [1.00, 0.6], [0.00, 0.5], [1.00, 0.6],
      [1.00, 0.6], [0.00, 0.5],
    ]
    return s6.map(([f, d]) => ({ setpointDisplay: S(s * f), durationS: d }))
  }

  // Phase 7: match benchmark — rotary match simulation, branches on mechType
  if (mechType === 'roller') {
    // Roller Phase 7 match benchmark: intake/conveyor cycling.
    // Negative fractions = reverse (unjam / outtake).
    const r6: [number, number][] = [
      // AUTO: spin up, intake 2 game pieces
      [0.00, 0.5], [1.00, 1.5], [0.00, 0.5], [1.00, 1.5], [0.00, 1.0],
      // EARLY TELEOP: rapid intake cycles (5 pieces)
      [1.00, 0.8], [0.00, 0.4], [1.00, 0.8], [0.00, 0.4],
      [1.00, 0.8], [0.00, 0.4], [1.00, 0.8], [0.00, 0.4],
      [1.00, 0.8], [0.00, 1.5],
      // OUTTAKE: reverse to unjam, then re-intake
      [-0.40, 0.4], [0.00, 0.3], [1.00, 0.8], [0.00, 0.5],
      // REPOSITIONING: drive to new intake zone, roller off
      [0.00, 2.5],
      // SECOND INTAKE SESSION
      [1.00, 0.8], [0.00, 0.4], [1.00, 0.8], [0.00, 0.4],
      [1.00, 0.8], [0.00, 0.4], [1.00, 0.8], [0.00, 2.0],
      // CAREFUL PICK-UP: reduced speed near alliance wall
      [0.70, 1.0], [0.00, 0.4], [0.70, 1.0], [0.00, 1.0],
      // FINAL SPRINT: urgent fast cycles end-of-match
      [1.00, 0.6], [0.00, 0.3], [1.00, 0.6], [0.00, 0.3],
      [1.00, 0.6], [0.00, 0.3], [1.00, 0.6], [0.00, 0.3],
      [1.00, 0.6], [0.00, 3.0],
    ]
    return r6.map(([f, d]) => ({
      setpointDisplay: f < 0 ? -S(s * Math.abs(f)) : S(s * f),
      durationS: d,
    }))
  }

  // Flywheel Phase 7 match benchmark: 2-minute match simulation (shooter).
  // "Shooting on the move" sections use structural setpoint variation — not random noise.
  const f6: [number, number][] = [
    // AUTO: spin-up, 3 shots, drive away
    [0.00, 0.8],  [1.00, 1.5],  [0.85, 0.6], [1.00, 0.6], [0.85, 0.6],
    [1.00, 0.6],  [0.85, 0.6],  [1.00, 0.8], [0.15, 2.0],
    // EARLY TELEOP: fixed-position shot cluster
    [1.00, 0.8],  [0.85, 0.5],  [1.00, 0.6], [0.85, 0.5], [1.00, 0.6],
    [0.85, 0.5],  [1.00, 0.6],  [0.85, 0.5], [1.00, 0.8], [0.20, 1.5],
    // SHOOTING ON THE MOVE 1: camera-correction setpoint variation
    [0.95, 0.5],  [0.88, 0.4],  [1.00, 0.5], [0.92, 0.4], [0.98, 0.5],
    [0.86, 0.4],  [1.00, 0.5],  [0.90, 0.4], [0.97, 0.5], [0.84, 0.4],
    [1.00, 0.5],  [0.93, 0.4],  [0.88, 0.5], [1.00, 0.5], [0.15, 1.5],
    // MID-MATCH REPOSITIONING
    [0.15, 3.0],  [1.00, 0.8],  [0.85, 0.5], [1.00, 0.6], [0.85, 0.5],
    [1.00, 0.6],  [0.20, 3.0],
    // SHOOTING ON THE MOVE 2
    [0.90, 0.5],  [1.00, 0.4],  [0.87, 0.5], [0.97, 0.4], [1.00, 0.5],
    [0.91, 0.4],  [0.85, 0.5],  [1.00, 0.4], [0.93, 0.5], [0.88, 0.4],
    [1.00, 0.5],  [0.95, 0.5],  [0.20, 1.5],
    // LATE-MATCH: urgent full-power shots
    [1.00, 1.0],  [0.85, 0.5],  [1.00, 0.6], [0.85, 0.5], [1.00, 0.6],
    [0.85, 0.5],  [1.00, 0.6],  [0.85, 0.5], [1.00, 0.6], [0.85, 0.5],
    [1.00, 0.6],  [0.85, 0.5],  [1.00, 1.0],
    // WIND-DOWN
    [0.50, 2.0],  [0.25, 2.0],  [0.00, 3.0],
  ]
  return f6.map(([f, d]) => ({ setpointDisplay: S(s * f), durationS: d }))
}

// ─── Display unit label ───────────────────────────────────────────────────────

export function displayUnitLabel(cfg: MechanismConfig): string {
  if (isRotary(cfg.type)) return 'RPM'
  if (cfg.type === 'arm')  return '°'
  return 'm'
}

export function defaultSetpoint(cfg: MechanismConfig): number {
  if (cfg.type === 'flywheel') return 3000
  if (cfg.type === 'roller')   return 1000
  if (cfg.type === 'arm')      return 45
  return 1.0
}

// ─── Baseline gain calculator ─────────────────────────────────────────────────

export function calculateBaselineGains(cfg: MechanismConfig): import('../types').Gains {
  const motor = MOTORS[cfg.motorType]
  const kV    = motorKvCTRE(motor)

  let J_mech: number
  if      (isRotary(cfg.type))        J_mech = 0.5 * cfg.massKg * cfg.radiusM ** 2
  else if (cfg.type === 'arm')        J_mech = (1 / 3) * cfg.massKg * cfg.lengthM ** 2
  else                                J_mech = cfg.massKg * cfg.spoolRadiusM ** 2

  const J_motor = cfg.numMotors * motor.rotorInertiaKgM2 * cfg.gearRatio ** 2
  const J_total = J_mech + J_motor

  const kA = J_total * motor.resistanceOhms * 2 * Math.PI /
    (motor.KtNmPerAmp * cfg.numMotors * cfg.gearRatio ** 2)

  let kG = 0
  if (cfg.type === 'arm') {
    const cgDist = cfg.cgDistanceM ?? cfg.lengthM / 2
    kG = cfg.massKg * GRAVITY * cgDist * motor.resistanceOhms /
      (motor.KtNmPerAmp * cfg.numMotors * cfg.gearRatio)
  } else if (cfg.type === 'elevator') {
    kG = cfg.massKg * GRAVITY * cfg.spoolRadiusM * motor.resistanceOhms /
      (motor.KtNmPerAmp * cfg.numMotors * cfg.gearRatio)
  }

  return {
    kP: isRotary(cfg.type) ? 0.05 : 1.0,
    kI: 0,
    kD: 0,
    kS: 0.25,
    kV: parseFloat(kV.toFixed(4)),
    kA: parseFloat(kA.toFixed(4)),
    kG: parseFloat(kG.toFixed(4)),
  }
}

// ─── Phase 6 stress diagnostics ───────────────────────────────────────────────

export function computeStressDiagnostics(
  result: MultiStepResult,
  steps: TestStep[],
  thresholds: StressThresholds
): StressDiagnostics {
  const { segmentMetrics, points, segmentBoundaries } = result

  const spMax = steps.reduce((m, s) => Math.max(m, Math.abs(s.setpointDisplay)), 1)
  const zeroThreshold = spMax * 0.05

  const segments: SegmentDiagnostic[] = segmentMetrics.map((seg, i) => {
    const currentSP = steps[i]?.setpointDisplay ?? 0
    const prevSP    = i > 0 ? (steps[i - 1]?.setpointDisplay ?? 0) : currentSP

    let stepType: SegmentDiagnostic['stepType']
    if (i === 0) {
      stepType = Math.abs(currentSP) > zeroThreshold ? 'ascend' : 'hold'
    } else if (Math.abs(prevSP) <= zeroThreshold && Math.abs(currentSP) > zeroThreshold) {
      stepType = 'recover-from-zero'
    } else if (currentSP > prevSP) {
      stepType = 'ascend'
    } else if (currentSP < prevSP) {
      stepType = 'descend'
    } else {
      stepType = 'hold'
    }

    // Max instantaneous |error| within this segment's time window
    const segStart = segmentBoundaries[i] ?? 0
    const segEnd   = segmentBoundaries[i + 1] ?? Infinity
    let maxErr = 0
    for (const pt of points) {
      if (pt.time < segStart) continue
      if (pt.time >= segEnd)  break
      const err = Math.abs(pt.setpoint - pt.actual)
      if (err > maxErr) maxErr = err
    }

    return {
      index:                 i,
      stepType,
      overshootPct:          seg.overshootPct,
      recoveryTimeS:         seg.settlingTimeS,
      maxInstantaneousError: maxErr,
      oscillationCount:      seg.oscillations,
    }
  })

  const zeroRecoveries = segments.filter(s => s.stepType === 'recover-from-zero')
  const maxRecoveryFromZeroS = zeroRecoveries.length > 0
    ? Math.max(...zeroRecoveries.map(s => s.recoveryTimeS))
    : 0

  const maxOvershootPct = segments.length > 0
    ? Math.max(...segments.map(s => s.overshootPct))
    : 0

  const oscillatingSegments = segments.filter(s => s.oscillationCount > 1).length

  const failureReasons: string[] = []

  if (zeroRecoveries.length > 0 && maxRecoveryFromZeroS > thresholds.maxRecoveryFromZeroS) {
    failureReasons.push(
      `Recovery from zero took ${maxRecoveryFromZeroS.toFixed(2)}s (limit: ${thresholds.maxRecoveryFromZeroS}s)`
    )
  }
  if (maxOvershootPct > thresholds.maxOvershootPct) {
    failureReasons.push(
      `Overshoot ${maxOvershootPct.toFixed(1)}% exceeds limit ${thresholds.maxOvershootPct}%`
    )
  }
  if (oscillatingSegments > thresholds.maxOscillatingSegments) {
    failureReasons.push(
      `${oscillatingSegments} oscillating segments exceeds limit of ${thresholds.maxOscillatingSegments}`
    )
  }

  return {
    segments,
    maxRecoveryFromZeroS,
    maxOvershootPct,
    oscillatingSegments,
    passed: failureReasons.length === 0,
    failureReasons,
  }
}
