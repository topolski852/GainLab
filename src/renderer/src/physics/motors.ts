// Motor specifications for GainLab physics simulation.
//
// Sources:
//  - Falcon 500:      CTRE datasheet / WPILib DCMotor.falcon500()
//  - Kraken X60:      WestCoast Products docs.wcproducts.com/welcome/electronics/kraken-x60
//  - Kraken X44:      WestCoast Products docs.wcproducts.com/welcome/electronics/kraken-x44
//                     + WCP blog (wcproducts.com/blogs/wcp-blog/kraken-x44) for Kt confirmation
//  - Minion:          CTRE store (stall torque 3.1 N·m, peak power 610 W confirmed);
//                     free speed and stall current derived via P_peak = τ_stall·ω_free/4
//                     and R = V²/(4·P_peak). Marked with ⚠ in comments below.
//
// FOC vs Trapezoidal:
//  Phoenix 6 uses Field-Oriented Control (FOC) by default. FOC variants have higher
//  stall torque and lower free speed than trapezoidal commutation. Use the FOC entry
//  if your team calls VelocityTorqueCurrentFOC / PositionTorqueCurrentFOC (default for
//  Phoenix 6 teams). Use the Trap entry only if you explicitly disable FOC.

export type CommutationType = 'foc' | 'trapezoidal'

export interface MotorSpec {
  id: string
  name: string
  shortName: string
  commutation: CommutationType
  freeSpeedRPM: number
  stallTorqueNm: number
  stallCurrentA: number
  freeCurrentA: number
  peakPowerW: number
  massKg: number
  // Derived from the above (computed at definition time for clarity)
  resistanceOhms: number       // V_supply / I_stall
  KtNmPerAmp: number           // τ_stall / I_stall
  KvRadPerSecPerVolt: number   // ω_free_rad_per_s / V_supply
  // Rotor moment of inertia (kg·m²). Measured or estimated from motor dimensions.
  // Reflected through gear ratio² when computing effective mechanism inertia.
  rotorInertiaKgM2: number
}

const V = 12  // nominal supply voltage (V)

function kv(freeSpeedRPM: number): number {
  return (freeSpeedRPM * 2 * Math.PI / 60) / V
}

export const MOTORS: Record<string, MotorSpec> = {

  // ── Falcon 500 (TalonFX) ───────────────────────────────────────────────────
  // CTRE official datasheet. Phoenix 6 supports FOC on Falcon 500 but CTRE
  // has not published separate FOC-mode dyno curves; these nameplate values are
  // used by WPILib's DCMotor.falcon500() and are the community standard.
  falcon500: {
    id: 'falcon500',
    name: 'Falcon 500 (TalonFX)',
    shortName: 'Falcon 500',
    commutation: 'foc',
    freeSpeedRPM:  6380,
    stallTorqueNm: 4.69,
    stallCurrentA: 257,
    freeCurrentA:  1.5,
    peakPowerW:    783,
    massKg:        0.499,
    resistanceOhms:       V / 257,
    KtNmPerAmp:           4.69 / 257,
    KvRadPerSecPerVolt:   kv(6380),
    rotorInertiaKgM2:     9.37e-5,   // documented value
  },

  // ── Kraken X60 — FOC (TalonFX) ────────────────────────────────────────────
  // Source: docs.wcproducts.com/welcome/electronics/kraken-x60/motor-performance
  // Use this entry if running Phoenix 6 with FOC (default for most teams).
  krakenX60: {
    id: 'krakenX60',
    name: 'Kraken X60 — FOC (TalonFX)',
    shortName: 'Kraken X60',
    commutation: 'foc',
    freeSpeedRPM:  5800,
    stallTorqueNm: 9.37,
    stallCurrentA: 483,
    freeCurrentA:  2,
    peakPowerW:    1405,
    massKg:        0.544,
    resistanceOhms:       V / 483,
    KtNmPerAmp:           9.37 / 483,
    KvRadPerSecPerVolt:   kv(5800),
    rotorInertiaKgM2:     7.37e-5,
  },

  // ── Kraken X60 — Trapezoidal (TalonFX) ────────────────────────────────────
  // Same motor, Phoenix 6 with FOC disabled. Lower stall torque, higher free speed.
  krakenX60Trap: {
    id: 'krakenX60Trap',
    name: 'Kraken X60 — Trapezoidal (TalonFX)',
    shortName: 'Kraken X60 (Trap)',
    commutation: 'trapezoidal',
    freeSpeedRPM:  6000,
    stallTorqueNm: 7.09,
    stallCurrentA: 366,
    freeCurrentA:  2,
    peakPowerW:    1108,
    massKg:        0.544,
    resistanceOhms:       V / 366,
    KtNmPerAmp:           7.09 / 366,
    KvRadPerSecPerVolt:   kv(6000),
    rotorInertiaKgM2:     7.37e-5,
  },

  // ── Kraken X44 — FOC (TalonFX) ────────────────────────────────────────────
  // Source: docs.wcproducts.com/welcome/electronics/kraken-x44 (final specs).
  // Kt = 15.37 mN·m/A confirmed by WCP dyno data.
  // Rotor inertia estimated from 44 mm diameter, 340 g motor mass.
  krakenX44: {
    id: 'krakenX44',
    name: 'Kraken X44 — FOC (TalonFX)',
    shortName: 'Kraken X44',
    commutation: 'foc',
    freeSpeedRPM:  7368,
    stallTorqueNm: 5.01,
    stallCurrentA: 329,
    freeCurrentA:  3,
    peakPowerW:    966,
    massKg:        0.340,
    resistanceOhms:       V / 329,
    KtNmPerAmp:           0.01537,   // 15.37 mN·m/A from WCP
    KvRadPerSecPerVolt:   kv(7368),
    rotorInertiaKgM2:     3.50e-5,   // estimated: (44/60)² × X60 inertia
  },

  // ── Kraken X44 — Trapezoidal (TalonFX) ────────────────────────────────────
  // Kt = 14.91 mN·m/A confirmed by WCP dyno data.
  krakenX44Trap: {
    id: 'krakenX44Trap',
    name: 'Kraken X44 — Trapezoidal (TalonFX)',
    shortName: 'Kraken X44 (Trap)',
    commutation: 'trapezoidal',
    freeSpeedRPM:  7758,
    stallTorqueNm: 4.11,
    stallCurrentA: 279,
    freeCurrentA:  3,
    peakPowerW:    835,
    massKg:        0.340,
    resistanceOhms:       V / 279,
    KtNmPerAmp:           0.01491,   // 14.91 mN·m/A from WCP
    KvRadPerSecPerVolt:   kv(7758),
    rotorInertiaKgM2:     3.50e-5,
  },

  // ── CTRE Minion (Talon FXS) ───────────────────────────────────────────────
  // Confirmed: stallTorqueNm = 3.1 N·m, peakPowerW = 610 W, massKg = 0.295 kg.
  // ⚠ Derived values (CTRE has not published full dyno data as of 2025):
  //   freeSpeedRPM: P_peak = τ_stall × ω_free / 4  →  ω_free = 4×610/3.1 = 787 rad/s = 7513 RPM
  //   stallCurrentA: R = V²/(4×P_peak) = 144/2440 = 0.059 Ω  →  I_stall = V/R ≈ 203 A
  //   freeCurrentA: estimated ~2 A (typical for this motor class)
  //   rotorInertiaKgM2: estimated from physical dimensions (compact form factor)
  minion: {
    id: 'minion',
    name: 'CTRE Minion (Talon FXS)',
    shortName: 'Minion',
    commutation: 'foc',
    freeSpeedRPM:  7530,           // ⚠ derived
    stallTorqueNm: 3.1,            // ✓ confirmed
    stallCurrentA: 203,            // ⚠ derived
    freeCurrentA:  2,              // ⚠ estimated
    peakPowerW:    610,            // ✓ confirmed
    massKg:        0.295,          // ✓ confirmed (0.65 lbs)
    resistanceOhms:       V / 203, // ⚠ derived: 0.059 Ω
    KtNmPerAmp:           3.1 / 203,    // ⚠ derived: 15.27 mN·m/A
    KvRadPerSecPerVolt:   kv(7530),     // ⚠ derived
    rotorInertiaKgM2:     1.50e-5,      // ⚠ estimated (compact, 295 g motor)
  },
}

export const MOTOR_LIST = Object.values(MOTORS)

// Motor groups for organized UI display
export const MOTOR_GROUPS: { label: string; ids: string[] }[] = [
  { label: 'Falcon 500',  ids: ['falcon500'] },
  { label: 'Kraken X60', ids: ['krakenX60', 'krakenX60Trap'] },
  { label: 'Kraken X44', ids: ['krakenX44', 'krakenX44Trap'] },
  { label: 'Minion',     ids: ['minion'] },
]

// kV in CTRE Phoenix 6 units: V per (rot/s at rotor) = V·s/rot
// This equals Slot0.kV in a VelocityVoltage / VelocityTorqueCurrentFOC request.
export function motorKvCTRE(motor: MotorSpec): number {
  return V / (motor.freeSpeedRPM / 60)
}

// Human-readable spec summary for tooltip / info panel
export function motorSummary(motor: MotorSpec): string {
  return [
    `Free Speed: ${motor.freeSpeedRPM.toLocaleString()} RPM`,
    `Stall Torque: ${motor.stallTorqueNm.toFixed(2)} N·m`,
    `Stall Current: ${motor.stallCurrentA} A`,
    `Peak Power: ${motor.peakPowerW} W`,
    `Mass: ${(motor.massKg * 1000).toFixed(0)} g`,
    motor.commutation === 'foc' ? 'FOC enabled' : 'Trapezoidal commutation',
  ].join(' · ')
}
