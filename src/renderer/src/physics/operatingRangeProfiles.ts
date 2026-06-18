import { ControlMode, MechanismType } from '../types'

export interface OperatingRangeDefaults {
  min: number
  nominal: number
  max: number
}

// Keyed by "controlMode:mechType" — every valid combo from validMechTypes() in MotorConfigModal.
const PROFILES: Record<string, OperatingRangeDefaults> = {
  // ── Velocity ──────────────────────────────────────────────────────────────
  // RPM — flywheel shooters typically run 3000–6000, intake rollers 1500–3500
  'VELOCITY:flywheel': { min: 0,     nominal: 4000, max: 6000  },
  'VELOCITY:roller':   { min: 0,     nominal: 2000, max: 3500  },

  // ── Position ─────────────────────────────────────────────────────────────
  // arm: degrees — stow at 0°, deploy at 90°, hard ceiling 120°
  // elevator: meters — retracted at 0, mid at 0.6 m, full extension 1.2 m
  'POSITION:arm':      { min: 0,     nominal: 90,   max: 120   },
  'POSITION:elevator': { min: 0,     nominal: 0.6,  max: 1.2   },

  // ── Motion Magic ─────────────────────────────────────────────────────────
  // Same physical ranges as Position; Motion Magic just adds a velocity profile
  'MOTION_MAGIC:arm':      { min: 0, nominal: 90,   max: 120   },
  'MOTION_MAGIC:elevator': { min: 0, nominal: 0.6,  max: 1.2   },

  // ── Torque (TorqueCurrentFOC) ─────────────────────────────────────────────
  // Amps — typical FRC intake/roller: 15–30 A nominal, 40 A peak
  'TORQUE:roller': { min: 0, nominal: 20, max: 40 },

  // ── Duty Cycle (open-loop) ────────────────────────────────────────────────
  // Percent (0–100) — useful for bench testing before adding a sensor
  'DUTY_CYCLE:flywheel': { min: 0, nominal: 70, max: 100 },
  'DUTY_CYCLE:roller':   { min: 0, nominal: 50, max: 100 },
}

export function getOperatingRangeDefaults(
  mode: ControlMode,
  mechType: MechanismType,
): OperatingRangeDefaults | null {
  return PROFILES[`${mode}:${mechType}`] ?? null
}
