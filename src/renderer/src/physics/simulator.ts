import { MechanismConfig, Gains, StepResponsePoint, StepMetrics } from '../types'
import { MOTORS, motorKvCTRE } from './motors'

const PHYSICS_DT = 0.005   // 5 ms physics integration step
const PID_DT = 0.020       // 20 ms PID update (matches Phoenix 6 control loop)
const SUPPLY_VOLTAGE = 12.0
const GRAVITY = 9.81

// ─── Unit conversion helpers ──────────────────────────────────────────────────
// All simulation state is SI (rad/s, rad, m/s, m).
// CTRE Phoenix 6 uses rotor-referred units: RPS for velocity, rotations for position.
// Gains are expressed in CTRE units so they transfer directly to robot code.

function siToDisplayUnits(siVal: number, config: MechanismConfig): number {
  if (config.type === 'flywheel') return siVal * config.gearRatio * 60 / (2 * Math.PI) // rad/s mech → rotor RPM
  if (config.type === 'arm') return siVal * 180 / Math.PI                                // rad → degrees
  return siVal                                                                             // elevator: meters
}

function displayToSI(displayVal: number, config: MechanismConfig): number {
  if (config.type === 'flywheel') return displayVal * 2 * Math.PI / (60 * config.gearRatio)
  if (config.type === 'arm') return displayVal * Math.PI / 180
  return displayVal
}

// CTRE rotor units ↔ SI mechanism units
function ctreToSI(ctreVal: number, config: MechanismConfig): number {
  if (config.type === 'flywheel') return ctreVal * 2 * Math.PI / config.gearRatio  // rotor RPS → mech rad/s
  if (config.type === 'arm') return ctreVal * 2 * Math.PI / config.gearRatio       // rotor rot → mech rad
  return ctreVal * 2 * Math.PI * config.spoolRadiusM / config.gearRatio            // rotor rot → m
}

function siToCTRE(siVal: number, config: MechanismConfig): number {
  if (config.type === 'flywheel') return siVal * config.gearRatio / (2 * Math.PI)
  if (config.type === 'arm') return siVal * config.gearRatio / (2 * Math.PI)
  return siVal * config.gearRatio / (2 * Math.PI * config.spoolRadiusM)
}

// ─── Baseline gain calculator ─────────────────────────────────────────────────

export function calculateBaselineGains(config: MechanismConfig): Gains {
  const motor = MOTORS[config.motorType]
  const kV = motorKvCTRE(motor)  // V·s/rot at rotor

  // kA: voltage needed per RPS/s of rotor acceleration
  // Derived from τ = J·α, reflected to rotor, then V = τ·R / (Kt·N²)
  let J_mech: number
  if (config.type === 'flywheel') {
    J_mech = 0.5 * config.massKg * config.radiusM * config.radiusM
  } else if (config.type === 'arm') {
    J_mech = (1 / 3) * config.massKg * config.lengthM * config.lengthM
  } else {
    J_mech = config.massKg * config.spoolRadiusM * config.spoolRadiusM
  }
  const J_motor_reflected = config.numMotors * motor.rotorInertiaKgM2 * config.gearRatio ** 2
  const J_total = J_mech + J_motor_reflected
  // V per (RPS/s at rotor): V = (J_total / (N²)) * alpha_rotor * R / (Kt * numMotors)
  // alpha_rotor [rad/s²] = alpha_rps * 2π
  const kA = J_total * motor.resistanceOhms * 2 * Math.PI /
    (motor.KtNmPerAmp * config.numMotors * config.gearRatio ** 2)

  let kG = 0
  if (config.type === 'arm') {
    // Voltage to hold arm horizontal: τ_grav = m·g·(L/2); V = τ_grav·R / (Kt·N·gearRatio)
    kG = config.massKg * GRAVITY * (config.lengthM / 2) * motor.resistanceOhms /
      (motor.KtNmPerAmp * config.numMotors * config.gearRatio)
  } else if (config.type === 'elevator') {
    const forceGrav = config.massKg * GRAVITY
    kG = forceGrav * config.spoolRadiusM * motor.resistanceOhms /
      (motor.KtNmPerAmp * config.numMotors * config.gearRatio)
  }

  return {
    kP: config.type === 'flywheel' ? 0.05 : 1.0,
    kI: 0,
    kD: 0,
    kS: 0.25,
    kV: parseFloat(kV.toFixed(4)),
    kA: parseFloat(kA.toFixed(4)),
    kG: parseFloat(kG.toFixed(4))
  }
}

// ─── Core simulation ──────────────────────────────────────────────────────────

export function runSimulation(
  config: MechanismConfig,
  gains: Gains,
  setpointDisplay: number,
  durationS = 2.0
): { points: StepResponsePoint[]; metrics: StepMetrics } {
  const motor = MOTORS[config.motorType]
  const setpointSI = displayToSI(setpointDisplay, config)
  const setpointCTRE = siToCTRE(setpointSI, config)

  // Effective inertia at mechanism output (kg·m² for rotation, kg for linear)
  let J_eff: number
  const J_motor_reflected = config.numMotors * motor.rotorInertiaKgM2 * config.gearRatio ** 2

  if (config.type === 'flywheel') {
    J_eff = 0.5 * config.massKg * config.radiusM ** 2 + J_motor_reflected
  } else if (config.type === 'arm') {
    J_eff = (1 / 3) * config.massKg * config.lengthM ** 2 + J_motor_reflected
  } else {
    // Linear: effective mass (kg), motor inertia reflected through spool
    J_eff = config.massKg + J_motor_reflected / config.spoolRadiusM ** 2
  }

  // SI state
  let omega_mech = 0   // rad/s (flywheel: mech velocity; arm: angular velocity)
  let theta_mech = config.type === 'arm'
    ? (config.startAngleDeg * Math.PI / 180)
    : 0                // rad (arm position)
  let v_elev = 0       // m/s
  let y_elev = config.type === 'elevator' ? config.startHeightM : 0  // m

  // PID state
  let integral = 0
  let prevError = 0
  let pidTimer = 0
  let voltage = 0      // last PID output (voltage)

  const points: StepResponsePoint[] = []
  const freeSpeedRadps = motor.freeSpeedRPM * 2 * Math.PI / 60

  // Record every 20ms to keep data volume manageable
  const recordEvery = Math.round(PID_DT / PHYSICS_DT)
  let stepCount = 0

  for (let t = 0; t <= durationS + PHYSICS_DT * 0.5; t += PHYSICS_DT) {
    // ── PID update (20 ms) ─────────────────────────────────────────────────
    if (pidTimer >= PID_DT - PHYSICS_DT * 0.5) {
      let actualCTRE: number
      if (config.type === 'flywheel') {
        actualCTRE = siToCTRE(omega_mech, config)
      } else if (config.type === 'arm') {
        actualCTRE = siToCTRE(theta_mech, config)
      } else {
        actualCTRE = siToCTRE(y_elev, config)
      }

      const error = setpointCTRE - actualCTRE
      integral += error * PID_DT
      integral = Math.max(-50, Math.min(50, integral))   // anti-windup
      const derivative = (error - prevError) / PID_DT
      prevError = error

      // Feedforward
      let ff = gains.kS * Math.sign(setpointCTRE) + gains.kV * setpointCTRE
      if (config.type === 'arm') {
        ff += gains.kG * Math.cos(theta_mech)    // cosine gravity comp
      } else if (config.type === 'elevator') {
        ff += gains.kG                             // constant gravity comp
      }

      voltage = gains.kP * error + gains.kI * integral + gains.kD * derivative + ff
      voltage = Math.max(-SUPPLY_VOLTAGE, Math.min(SUPPLY_VOLTAGE, voltage))
      pidTimer = 0
    }
    pidTimer += PHYSICS_DT

    // ── Motor physics (5 ms) ───────────────────────────────────────────────
    // Current rotor angular velocity (rad/s)
    let omega_rotor: number
    if (config.type === 'flywheel') {
      omega_rotor = omega_mech * config.gearRatio
    } else if (config.type === 'arm') {
      omega_rotor = omega_mech * config.gearRatio
    } else {
      omega_rotor = (v_elev / config.spoolRadiusM) * config.gearRatio
    }

    const v_bemf = omega_rotor / motor.KvRadPerSecPerVolt
    const current = (voltage - v_bemf) / motor.resistanceOhms
    const clampedCurrent = Math.max(-motor.stallCurrentA, Math.min(motor.stallCurrentA, current))
    const torquePerMotor = clampedCurrent * motor.KtNmPerAmp

    if (config.type === 'flywheel') {
      const torque_mech = torquePerMotor * config.numMotors * config.gearRatio
      omega_mech += (torque_mech / J_eff) * PHYSICS_DT

    } else if (config.type === 'arm') {
      const torque_mech = torquePerMotor * config.numMotors * config.gearRatio
      const torque_gravity = config.massKg * GRAVITY * (config.lengthM / 2) * Math.cos(theta_mech)
      const alpha = (torque_mech - torque_gravity) / J_eff
      omega_mech += alpha * PHYSICS_DT
      theta_mech += omega_mech * PHYSICS_DT

    } else {
      const force_motor = torquePerMotor * config.numMotors * config.gearRatio / config.spoolRadiusM
      const force_net = force_motor - config.massKg * GRAVITY
      v_elev += (force_net / J_eff) * PHYSICS_DT
      y_elev = Math.max(0, y_elev + v_elev * PHYSICS_DT)
      if (y_elev === 0 && v_elev < 0) v_elev = 0   // floor collision
    }

    // ── Record point ───────────────────────────────────────────────────────
    if (stepCount % recordEvery === 0) {
      let actualDisplay: number
      if (config.type === 'flywheel') {
        actualDisplay = siToDisplayUnits(omega_mech, config)
      } else if (config.type === 'arm') {
        actualDisplay = siToDisplayUnits(theta_mech, config)
      } else {
        actualDisplay = y_elev
      }

      points.push({
        time: parseFloat(t.toFixed(3)),
        setpoint: setpointDisplay,
        actual: parseFloat(actualDisplay.toFixed(4))
      })
    }
    stepCount++
  }

  const metrics = calculateMetrics(points, setpointDisplay)
  return { points, metrics }
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

function calculateMetrics(points: StepResponsePoint[], setpoint: number): StepMetrics {
  if (points.length === 0 || setpoint === 0) {
    return { riseTimeS: -1, overshootPct: 0, settlingTimeS: -1, steadyStateError: 0, score: 999 }
  }

  const band = 0.02 * Math.abs(setpoint)
  let rise10 = -1
  let rise90 = -1
  let maxActual = -Infinity
  let settlingTime = -1

  for (const pt of points) {
    if (pt.actual > maxActual) maxActual = pt.actual
    if (rise10 < 0 && pt.actual >= 0.1 * setpoint) rise10 = pt.time
    if (rise90 < 0 && pt.actual >= 0.9 * setpoint) rise90 = pt.time
  }

  // Settling: last time the response is outside the 2% band
  for (let i = points.length - 1; i >= 0; i--) {
    if (Math.abs(points[i].actual - setpoint) > band) {
      settlingTime = i + 1 < points.length ? points[i + 1].time : points[i].time
      break
    }
  }
  if (settlingTime < 0) settlingTime = 0  // already settled at t=0 (unusual but fine)

  const riseTimeS = rise90 >= 0 && rise10 >= 0 ? rise90 - rise10 : -1
  const overshootPct = setpoint > 0
    ? Math.max(0, (maxActual - setpoint) / Math.abs(setpoint) * 100)
    : 0

  const lastN = Math.max(1, Math.floor(points.length * 0.2))
  const ssError = points.slice(-lastN).reduce(
    (sum, pt) => sum + Math.abs(pt.setpoint - pt.actual), 0
  ) / lastN
  const ssErrorPct = Math.abs(setpoint) > 0 ? ssError / Math.abs(setpoint) * 100 : ssError

  // Composite score (lower = better); weights tuned for FRC feel
  const score =
    overshootPct * 0.35 +
    (riseTimeS >= 0 ? riseTimeS * 30 : 60) * 0.30 +
    (settlingTime >= 0 ? settlingTime * 15 : 30) * 0.25 +
    ssErrorPct * 0.10

  return {
    riseTimeS,
    overshootPct,
    settlingTimeS: settlingTime,
    steadyStateError: ssError,
    score
  }
}

// ─── Display unit labels ──────────────────────────────────────────────────────

export function displayUnitLabel(config: MechanismConfig): string {
  if (config.type === 'flywheel') return 'RPM'
  if (config.type === 'arm') return '°'
  return 'm'
}

export function defaultSetpoint(config: MechanismConfig): number {
  if (config.type === 'flywheel') return 3000   // RPM
  if (config.type === 'arm') return 45           // degrees
  return 1.0                                     // meters
}
