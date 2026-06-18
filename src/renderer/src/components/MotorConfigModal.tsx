import { useState } from 'react'
import {
  MotorProfile, NamedSetpoint, GravityType, FeedbackSource, LimitType,
  MotorType, MechanismType, ControlMode
} from '../types'
import { MOTORS, MOTOR_GROUPS } from '../physics/motors'
import { getOperatingRangeDefaults } from '../physics/operatingRangeProfiles'
import NumericInput from './NumericInput'

interface Props {
  motor: MotorProfile
  mode: 'add' | 'edit'
  onSave: (motor: MotorProfile) => void
  onCancel: () => void
}

function validMechTypes(mode: ControlMode): MechanismType[] {
  if (mode === 'POSITION' || mode === 'MOTION_MAGIC') return ['arm', 'elevator']
  if (mode === 'TORQUE')                              return ['roller']
  return ['flywheel', 'roller']  // VELOCITY, DUTY_CYCLE
}

function defaultMechForMode(mode: ControlMode): MechanismType {
  if (mode === 'POSITION' || mode === 'MOTION_MAGIC') return 'arm'
  return 'roller'
}

const MODE_INFO: Record<ControlMode, { label: string; description: string }> = {
  VELOCITY: {
    label: 'Velocity',
    description: 'Maintains a target velocity using kS + kV feedforward and kP/kI/kD feedback. Best for flywheels, rollers, and conveyors where consistent speed matters.',
  },
  POSITION: {
    label: 'Position',
    description: 'Holds a target position. kG adds gravity feedforward — cosine-scaled for arms, constant for elevators. Best for arms, turrets, and elevators.',
  },
  MOTION_MAGIC: {
    label: 'Motion Magic',
    description: 'Profiled position control — generates a smooth trapezoidal velocity profile to reach the target. Same gains as Position. Set CruiseVelocity, Acceleration, and Jerk in MotionMagicConfigs in your robot code.',
  },
  TORQUE: {
    label: 'Torque (TorqueCurrentFOC)',
    description: 'Commands stator current directly — proportional to torque output. Battery-efficient when external load adds back-torque (e.g. an intake gripping a ball: the load current is zero-summed instead of dissipated as heat). kP/kD units are V/A and V·s/A. Requires Phoenix Pro.',
  },
  DUTY_CYCLE: {
    label: 'Duty Cycle',
    description: 'Open-loop output as a fraction of battery voltage (−1.0 to +1.0). No PID, no sensor feedback. Use for bench testing or simple mechanisms that don\'t need precise control.',
  },
}

function Tooltip({ text }: { text: string }): JSX.Element {
  return (
    <span className="cfg-tooltip">
      <span className="cfg-tooltip-icon">?</span>
      <span className="cfg-tooltip-text">{text}</span>
    </span>
  )
}

function setpointUnit(mechType: MechanismType, controlMode: ControlMode): string {
  if (controlMode === 'TORQUE') return 'A'
  if (controlMode === 'DUTY_CYCLE') return '%'
  if (mechType === 'arm') return '°'
  if (mechType === 'elevator') return 'm'
  return 'RPM'
}

function setpointStep(mechType: MechanismType, controlMode: ControlMode): number {
  if (controlMode === 'TORQUE') return 10
  if (controlMode === 'DUTY_CYCLE') return 5
  if (mechType === 'arm') return 5
  if (mechType === 'elevator') return 0.1
  return 100
}

export default function MotorConfigModal({ motor, mode, onSave, onCancel }: Props): JSX.Element {
  const [draft, setDraft] = useState<MotorProfile>({ ...motor, namedSetpoints: [...motor.namedSetpoints] })
  const [gearNumer, setGearNumer] = useState<number>(() => motor.mechanism.gearRatio)
  const [gearDenom, setGearDenom] = useState<number>(1)
  const [newSPName, setNewSPName] = useState('')
  const [newSPValue, setNewSPValue] = useState('')

  function handleControlModeChange(newMode: ControlMode): void {
    const valid   = validMechTypes(newMode)
    const newType = valid.includes(draft.mechanism.type) ? draft.mechanism.type : defaultMechForMode(newMode)
    const range   = getOperatingRangeDefaults(newMode, newType)
    setDraft(prev => ({
      ...prev,
      controlMode: newMode,
      mechanism: { ...prev.mechanism, type: newType },
      ...(range ? { minSetpoint: range.min, nominalSetpoint: range.nominal, maxSetpoint: range.max } : {}),
    }))
  }

  function handleMechTypeChange(newType: MechanismType): void {
    const range = getOperatingRangeDefaults(draft.controlMode, newType)
    setDraft(prev => ({
      ...prev,
      mechanism: { ...prev.mechanism, type: newType },
      ...(range ? { minSetpoint: range.min, nominalSetpoint: range.nominal, maxSetpoint: range.max } : {}),
    }))
  }

  function applyRangeSuggestion(): void {
    const range = getOperatingRangeDefaults(draft.controlMode, draft.mechanism.type)
    if (!range) return
    setDraft(prev => ({ ...prev, minSetpoint: range.min, nominalSetpoint: range.nominal, maxSetpoint: range.max }))
  }

  // ── Visibility flags ──────────────────────────────────────────────────────────
  const isPositionBased = draft.controlMode === 'POSITION' || draft.controlMode === 'MOTION_MAGIC'
  const isTorqueMode    = draft.controlMode === 'TORQUE'
  const isDutyCycle     = draft.controlMode === 'DUTY_CYCLE'
  const showPIDSlot      = !isDutyCycle
  const showGravityComp  = isPositionBased && (draft.mechanism.type === 'arm' || draft.mechanism.type === 'elevator')
  const showVoltageLimits = !isTorqueMode && !isDutyCycle
  const showFeedbackSensor = !isDutyCycle
  const showContinuousWrap = isPositionBased

  const unit  = setpointUnit(draft.mechanism.type, draft.controlMode)
  const step  = setpointStep(draft.mechanism.type, draft.controlMode)
  const title = mode === 'add' ? 'Add Motor' : `Configure — ${motor.name}`
  const modeInfo = MODE_INFO[draft.controlMode]

  // ── State helpers ─────────────────────────────────────────────────────────────

  function set<K extends keyof MotorProfile>(key: K, value: MotorProfile[K]): void {
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  function setMech<K extends keyof MotorProfile['mechanism']>(key: K, value: MotorProfile['mechanism'][K]): void {
    setDraft(prev => ({ ...prev, mechanism: { ...prev.mechanism, [key]: value } }))
  }

  function handleGearNumer(val: number): void {
    setGearNumer(val)
    setMech('gearRatio', gearDenom > 0 ? val / gearDenom : val)
  }

  function handleGearDenom(val: number): void {
    setGearDenom(val)
    setMech('gearRatio', val > 0 ? gearNumer / val : gearNumer)
  }

  function addNamedSetpoint(): void {
    const name = newSPName.trim().toUpperCase().replace(/\s+/g, '_')
    const value = parseFloat(newSPValue)
    if (!name || isNaN(value)) return
    const sp: NamedSetpoint = { id: crypto.randomUUID(), name, value }
    setDraft(prev => ({ ...prev, namedSetpoints: [...prev.namedSetpoints, sp] }))
    setNewSPName('')
    setNewSPValue('')
  }

  function updateSPName(id: string, raw: string): void {
    setDraft(prev => ({
      ...prev,
      namedSetpoints: prev.namedSetpoints.map(sp =>
        sp.id !== id ? sp : { ...sp, name: raw.toUpperCase().replace(/\s+/g, '_') }
      )
    }))
  }

  function updateSPValue(id: string, value: number): void {
    setDraft(prev => ({
      ...prev,
      namedSetpoints: prev.namedSetpoints.map(sp =>
        sp.id !== id ? sp : { ...sp, value }
      )
    }))
  }

  function removeSP(id: string): void {
    setDraft(prev => ({ ...prev, namedSetpoints: prev.namedSetpoints.filter(sp => sp.id !== id) }))
  }

  return (
    <div className="motor-config-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="motor-config-modal">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="motor-config-header">
          <div className="motor-config-title">{title}</div>
          <button className="cfg-btn cfg-btn-cancel" onClick={onCancel}>Cancel</button>
          <button
            className="cfg-btn cfg-btn-save"
            onClick={() => onSave(draft)}
            disabled={!draft.name.trim()}
          >
            {mode === 'add' ? 'Add Motor' : 'Save'}
          </button>
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="motor-config-body">

          {/* ── Identity ────────────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">Identity</div>
            <div className="cfg-row-2">
              <div className="cfg-field">
                <div className="cfg-field-label">Motor Name</div>
                <input className="cfg-input" type="text" value={draft.name}
                  onChange={e => set('name', e.target.value)} placeholder="e.g. Shooter Top" />
              </div>
              <div className="cfg-field">
                <div className="cfg-field-label">CAN ID</div>
                <NumericInput className="cfg-input" min={0} max={62}
                  value={draft.canId} onChange={v => set('canId', Math.round(v))} />
              </div>
            </div>
            <div className="cfg-field">
              <div className="cfg-field-label">Description</div>
              <textarea className="cfg-textarea" rows={2} value={draft.description}
                onChange={e => set('description', e.target.value)}
                placeholder="Optional notes about this motor" />
            </div>
          </div>

          {/* ── Control ─────────────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">Control</div>
            <div className={showPIDSlot ? 'cfg-row-2' : undefined}>
              <div className="cfg-field">
                <div className="cfg-field-label">Control Mode</div>
                <select className="cfg-select" value={draft.controlMode}
                  onChange={e => handleControlModeChange(e.target.value as ControlMode)}>
                  {(Object.keys(MODE_INFO) as ControlMode[]).map(m => (
                    <option key={m} value={m}>{MODE_INFO[m].label}</option>
                  ))}
                </select>
              </div>
              {showPIDSlot && (
                <div className="cfg-field">
                  <div className="cfg-field-label">
                    PID Slot
                    <Tooltip text="Which Phoenix 6 gain slot this motor uses. Slot 0 is the primary — it also owns all base hardware settings. Slots 1–2 carry only gain values for runtime slot switching." />
                  </div>
                  <div className="cfg-tab-group">
                    {[0, 1, 2].map(s => (
                      <button key={s} className={`cfg-tab-btn ${draft.slotNumber === s ? 'active' : ''}`}
                        onClick={() => set('slotNumber', s)}>{s}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Mode description callout */}
            <div className="cfg-mode-desc">{modeInfo.description}</div>

            <label className="cfg-toggle">
              <input type="checkbox" checked={draft.inverted} onChange={e => set('inverted', e.target.checked)} />
              <span className="cfg-toggle-track" />
              <span className="cfg-toggle-label">Inverted</span>
            </label>
          </div>

          {/* ── Mechanism & Motor ────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">Mechanism &amp; Motor</div>
            <div className="cfg-field">
              <div className="cfg-field-label">Mechanism Type</div>
              <div className="cfg-tab-group">
                {validMechTypes(draft.controlMode).map(t => (
                  <button key={t} className={`cfg-tab-btn ${draft.mechanism.type === t ? 'active' : ''}`}
                    onClick={() => handleMechTypeChange(t)}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="cfg-row-2">
              <div className="cfg-field">
                <div className="cfg-field-label">Motor Type</div>
                <select className="cfg-select" value={draft.mechanism.motorType}
                  onChange={e => setMech('motorType', e.target.value as MotorType)}>
                  {MOTOR_GROUPS.map(group => (
                    <optgroup key={group.label} label={group.label}>
                      {group.ids.map(id => (
                        <option key={id} value={id}>{MOTORS[id].name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div className="cfg-field">
                <div className="cfg-field-label">Motor Count</div>
                <div className="cfg-tab-group">
                  {[1, 2, 3, 4].map(n => (
                    <button key={n} className={`cfg-tab-btn ${draft.mechanism.numMotors === n ? 'active' : ''}`}
                      onClick={() => setMech('numMotors', n)}>{n}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="cfg-field">
              <div className="cfg-field-label">
                Gear Ratio
                <Tooltip text="Motor rotations per output rotation. Write as input:output (e.g. 15:1 means motor spins 15× faster than the output shaft)." />
              </div>
              <div className="cfg-gear-ratio-row">
                <NumericInput className="cfg-input" min={0.01} step={0.5} value={gearNumer}
                  onChange={handleGearNumer} />
                <span className="cfg-gear-colon">:</span>
                <NumericInput className="cfg-input" min={0.01} step={0.5} value={gearDenom}
                  onChange={handleGearDenom} />
                <span className="cfg-gear-computed">= {(gearDenom > 0 ? gearNumer / gearDenom : gearNumer).toFixed(3)}:1</span>
              </div>
            </div>
            <div className="cfg-row-2">
              <div className="cfg-field">
                <div className="cfg-field-label">Mass (kg)</div>
                <NumericInput className="cfg-input" min={0.01} step={0.1} value={draft.mechanism.massKg}
                  onChange={v => setMech('massKg', v)} />
              </div>
              {(draft.mechanism.type === 'flywheel' || draft.mechanism.type === 'roller') && (
                <div className="cfg-field">
                  <div className="cfg-field-label">Radius (m)</div>
                  <NumericInput className="cfg-input" min={0.001} step={0.01} value={draft.mechanism.radiusM}
                    onChange={v => setMech('radiusM', v)} />
                </div>
              )}
              {draft.mechanism.type === 'arm' && (
                <div className="cfg-field">
                  <div className="cfg-field-label">Length (m)</div>
                  <NumericInput className="cfg-input" min={0.01} step={0.05} value={draft.mechanism.lengthM}
                    onChange={v => setMech('lengthM', v)} />
                </div>
              )}
              {draft.mechanism.type === 'elevator' && (
                <div className="cfg-field">
                  <div className="cfg-field-label">Spool Radius (m)</div>
                  <NumericInput className="cfg-input" min={0.001} step={0.005} value={draft.mechanism.spoolRadiusM}
                    onChange={v => setMech('spoolRadiusM', v)} />
                </div>
              )}
            </div>
            {draft.mechanism.type === 'arm' && (
              <div className="cfg-field">
                <div className="cfg-field-label">Start Angle (°)</div>
                <NumericInput className="cfg-input" step={5} value={draft.mechanism.startAngleDeg}
                  onChange={v => setMech('startAngleDeg', v)} />
              </div>
            )}
            {draft.mechanism.type === 'elevator' && (
              <div className="cfg-field">
                <div className="cfg-field-label">Start Height (m)</div>
                <NumericInput className="cfg-input" min={0} step={0.05} value={draft.mechanism.startHeightM}
                  onChange={v => setMech('startHeightM', v)} />
              </div>
            )}
          </div>

          {/* ── Operating Range ──────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">
              Operating Range
              {getOperatingRangeDefaults(draft.controlMode, draft.mechanism.type) && (
                <button className="cfg-suggest-btn" onClick={applyRangeSuggestion} title="Reset to suggested defaults for this mode and mechanism type">
                  ↺ Suggested
                </button>
              )}
            </div>
            <div className="cfg-note" style={{ marginBottom: 10 }}>
              {isTorqueMode
                ? 'Current range for auto-tune experiments. Nominal is the typical operating current.'
                : isDutyCycle
                  ? 'Duty cycle range for auto-tune experiments (−100% to +100%).'
                  : 'Auto-tune experiments stay within Min–Max. Nominal is the primary operating point.'}
            </div>
            <div className="cfg-row-3">
              <div className="cfg-field">
                <div className="cfg-field-label">
                  Min ({unit})
                  <Tooltip text={
                    isTorqueMode ? 'Minimum commanded current (A).' :
                    isDutyCycle  ? 'Minimum duty cycle (e.g. 0 for forward-only).' :
                    'Lowest setpoint the auto-tuner will use. Typically 0 for velocity motors, or stow position for arms/elevators.'
                  } />
                </div>
                <NumericInput className="cfg-input" step={step} value={draft.minSetpoint}
                  onChange={v => set('minSetpoint', v)} />
              </div>
              <div className="cfg-field">
                <div className="cfg-field-label">
                  Nominal ({unit})
                  <Tooltip text={
                    isTorqueMode ? 'Typical operating current — used as the baseline for auto-tune sequences.' :
                    isDutyCycle  ? 'Typical operating duty cycle.' :
                    'The primary operating setpoint — what the mechanism runs at during a match.'
                  } />
                </div>
                <NumericInput className="cfg-input" step={step} value={draft.nominalSetpoint}
                  onChange={v => set('nominalSetpoint', v)} />
              </div>
              <div className="cfg-field">
                <div className="cfg-field-label">
                  Max ({unit})
                  <Tooltip text={
                    isTorqueMode ? 'Maximum commanded current (A). Should not exceed peakForwardTorqueCurrent.' :
                    isDutyCycle  ? 'Maximum duty cycle (1.0 = full forward voltage).' :
                    'Hard ceiling the auto-tuner will not exceed. For shooters, the RPM above which vibration becomes a concern.'
                  } />
                </div>
                <NumericInput className="cfg-input" step={step} value={draft.maxSetpoint}
                  onChange={v => set('maxSetpoint', v)} />
              </div>
            </div>
          </div>

          {/* ── Named Setpoints ──────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">
              Setpoints
              <Tooltip text="Named operating positions for this motor. These become Java constants and are used in Phase 6 match simulation." />
            </div>
            <div className="cfg-note" style={{ marginBottom: 10 }}>
              {isTorqueMode
                ? 'Examples: IDLE_CURRENT, HOLD_CURRENT, INTAKE_CURRENT'
                : isDutyCycle
                  ? 'Examples: IDLE, FORWARD, REVERSE'
                  : 'Examples: IDLE_SPEED, LOB_SPEED, FULL_SPEED — or DEPLOYED_ANGLE, RETRACTED_ANGLE'}
            </div>

            {draft.namedSetpoints.length > 0 && (
              <div className="cfg-setpoint-list">
                {draft.namedSetpoints.map(sp => (
                  <div key={sp.id} className="cfg-setpoint-row">
                    <input
                      className="cfg-input cfg-setpoint-name"
                      type="text"
                      placeholder="CONSTANT_NAME"
                      value={sp.name}
                      onChange={e => updateSPName(sp.id, e.target.value)}
                    />
                    <span className="cfg-setpoint-eq">=</span>
                    <NumericInput
                      className="cfg-input cfg-setpoint-value"
                      step={step}
                      value={sp.value}
                      onChange={v => updateSPValue(sp.id, v)}
                    />
                    <span className="cfg-setpoint-unit">{unit}</span>
                    <button className="cfg-setpoint-remove" onClick={() => removeSP(sp.id)} title="Remove">×</button>
                  </div>
                ))}
              </div>
            )}

            <div className="cfg-setpoint-add-row">
              <input
                className="cfg-input cfg-setpoint-name"
                type="text"
                placeholder="CONSTANT_NAME"
                value={newSPName}
                onChange={e => setNewSPName(e.target.value.toUpperCase().replace(/\s+/g, '_'))}
                onKeyDown={e => { if (e.key === 'Enter') addNamedSetpoint() }}
              />
              <span className="cfg-setpoint-eq">=</span>
              <input
                className="cfg-input cfg-setpoint-value"
                type="number"
                step={step}
                placeholder="0"
                value={newSPValue}
                onChange={e => setNewSPValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addNamedSetpoint() }}
              />
              <span className="cfg-setpoint-unit">{unit}</span>
              <button
                className="cfg-setpoint-add-btn"
                onClick={addNamedSetpoint}
                disabled={!newSPName.trim() || !newSPValue}
              >+</button>
            </div>
          </div>

          {/* ── Gravity Compensation (position modes + arm/elevator only) ── */}
          {showGravityComp && (
            <div className="cfg-section">
              <div className="cfg-section-title">Gravity Compensation</div>
              <div className="cfg-field">
                <div className="cfg-field-label">
                  Gravity Type
                  <Tooltip text="Adds a kG term to counteract gravity. Cosine (arm): kG × cos(angle) — full correction horizontal, zero correction vertical. Constant (elevator): fixed kG offset regardless of position. The kG value is configured in the Gains panel." />
                </div>
                <div className="cfg-tab-group">
                  {(['NONE', 'COSINE', 'CONSTANT'] as GravityType[]).map(g => (
                    <button key={g} className={`cfg-tab-btn ${draft.gravityType === g ? 'active' : ''}`}
                      onClick={() => set('gravityType', g)}>
                      {g === 'NONE' ? 'None' : g === 'COSINE' ? 'Cosine (Arm)' : 'Constant (Elevator)'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="cfg-note">kG value is configured in the Gains panel after adding this motor</div>
            </div>
          )}

          {/* ── Voltage Limits (hidden for torque and duty cycle) ─────────── */}
          {showVoltageLimits && (
            <div className="cfg-section">
              <div className="cfg-section-title">Voltage Limits</div>
              <div className="cfg-row-2">
                <div className="cfg-field">
                  <div className="cfg-field-label">
                    Peak Forward Voltage (V)
                    <Tooltip text="Maximum output voltage in the forward direction. Reduce to soft-cap a mechanism's top speed without changing the velocity setpoint. Default 12 V (full battery)." />
                  </div>
                  <NumericInput className="cfg-input" step={0.5} value={draft.peakForwardVoltage}
                    onChange={v => set('peakForwardVoltage', v)} />
                </div>
                <div className="cfg-field">
                  <div className="cfg-field-label">
                    Peak Reverse Voltage (V)
                    <Tooltip text="Maximum output voltage in the reverse direction (negative value). Default −12 V." />
                  </div>
                  <NumericInput className="cfg-input" step={0.5} value={draft.peakReverseVoltage}
                    onChange={v => set('peakReverseVoltage', v)} />
                </div>
              </div>
            </div>
          )}

          {/* ── Current Limits ────────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">Current Limits</div>
            <div className="cfg-row-2">
              <div className="cfg-field">
                <div className="cfg-field-label">
                  Stator Current Limit (A)
                  <Tooltip text="Current in the motor windings — proportional to torque output. Limiting this protects gearboxes from shock loads and prevents thermal damage under stall. Default 120 A." />
                </div>
                <NumericInput className="cfg-input" min={0} step={5} value={draft.statorCurrentLimit}
                  onChange={v => set('statorCurrentLimit', v)} />
              </div>
              <div className="cfg-field">
                <div className="cfg-field-label">
                  Supply Current Limit (A)
                  <Tooltip text="Current drawn from the battery. Limiting this prevents brownouts during sustained high-demand operation. Default 70 A." />
                </div>
                <NumericInput className="cfg-input" min={0} step={5} value={draft.supplyCurrentLimit}
                  onChange={v => set('supplyCurrentLimit', v)} />
              </div>
            </div>
            {isTorqueMode && (
              <div className="cfg-row-2" style={{ marginTop: 8 }}>
                <div className="cfg-field">
                  <div className="cfg-field-label">
                    Peak Forward Torque Current (A)
                    <Tooltip text="Maximum forward stator current commanded in TorqueCurrentFOC mode. Acts as a ceiling on the torque setpoint — the motor will not be commanded above this even if your setpoint is higher. 800 A ≈ effectively unlimited." />
                  </div>
                  <NumericInput className="cfg-input" step={10} value={draft.peakForwardTorqueCurrent}
                    onChange={v => set('peakForwardTorqueCurrent', v)} />
                </div>
                <div className="cfg-field">
                  <div className="cfg-field-label">
                    Peak Reverse Torque Current (A)
                    <Tooltip text="Maximum reverse stator current in TorqueCurrentFOC mode (negative value). −800 A ≈ effectively unlimited." />
                  </div>
                  <NumericInput className="cfg-input" step={10} value={draft.peakReverseTorqueCurrent}
                    onChange={v => set('peakReverseTorqueCurrent', v)} />
                </div>
              </div>
            )}
          </div>

          {/* ── Feedback Sensor (hidden for duty cycle) ───────────────────── */}
          {showFeedbackSensor && (
            <div className="cfg-section">
              <div className="cfg-section-title">Feedback Sensor</div>
              <div className="cfg-field">
                <div className="cfg-field-label">
                  Feedback Source
                  <Tooltip text="Which sensor provides position/velocity feedback. RotorSensor is the internal TalonFX encoder — use it for most mechanisms. RemoteCANcoder or FusedCANcoder for absolute position from an external encoder." />
                </div>
                <select className="cfg-select" value={draft.feedbackSource}
                  onChange={e => set('feedbackSource', e.target.value as FeedbackSource)}>
                  <option value="RotorSensor">Rotor Sensor (internal)</option>
                  <option value="RemoteCANcoder">Remote CANcoder</option>
                  <option value="FusedCANcoder">Fused CANcoder</option>
                  <option value="SyncCANcoder">Sync CANcoder</option>
                </select>
              </div>
              {draft.feedbackSource !== 'RotorSensor' && (
                <div className="cfg-field">
                  <div className="cfg-field-label">
                    Remote Sensor CAN ID
                    <Tooltip text="CAN ID of the remote CANcoder device." />
                  </div>
                  <NumericInput className="cfg-input" min={0} max={62}
                    value={draft.feedbackRemoteSensorId}
                    onChange={v => set('feedbackRemoteSensorId', Math.round(v))} />
                </div>
              )}
              <div className="cfg-row-3">
                <div className="cfg-field">
                  <div className="cfg-field-label">
                    Rotor-to-Sensor
                    <Tooltip text="Gear ratio from the motor rotor to the feedback sensor shaft. Use 1.0 when the sensor is on the rotor." />
                  </div>
                  <NumericInput className="cfg-input" step={0.01} value={draft.rotorToSensorRatio}
                    onChange={v => set('rotorToSensorRatio', v)} />
                </div>
                <div className="cfg-field">
                  <div className="cfg-field-label">
                    Sensor-to-Mechanism
                    <Tooltip text="Gear ratio from the sensor to the mechanism output. Lets you express setpoints in mechanism units (degrees, meters) instead of raw rotations." />
                  </div>
                  <NumericInput className="cfg-input" step={0.01} value={draft.sensorToMechanismRatio}
                    onChange={v => set('sensorToMechanismRatio', v)} />
                </div>
                <div className="cfg-field">
                  <div className="cfg-field-label">
                    Rotor Offset (rot)
                    <Tooltip text="Position offset applied at startup. Use this to define where 'zero' is on your mechanism." />
                  </div>
                  <NumericInput className="cfg-input" step={0.01} value={draft.rotorOffset}
                    onChange={v => set('rotorOffset', v)} />
                </div>
              </div>
            </div>
          )}

          {/* ── Hardware Limit Switches ───────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">Hardware Limit Switches</div>

            <div className="cfg-limit-group-label">Forward Limit</div>
            <label className="cfg-toggle">
              <input type="checkbox" checked={draft.forwardLimitEnable}
                onChange={e => set('forwardLimitEnable', e.target.checked)} />
              <span className="cfg-toggle-track" />
              <span className="cfg-toggle-label">
                Enable Forward Limit
                <Tooltip text="When triggered, TalonFX cuts forward motor output. Use to prevent overextension." />
              </span>
            </label>
            {draft.forwardLimitEnable && (
              <div className="cfg-subsection">
                <label className="cfg-toggle">
                  <input type="checkbox" checked={draft.forwardLimitAutosetEnable}
                    onChange={e => set('forwardLimitAutosetEnable', e.target.checked)} />
                  <span className="cfg-toggle-track" />
                  <span className="cfg-toggle-label">
                    Auto-zero on trigger
                    <Tooltip text="Resets the sensor position when the forward limit trips. Useful for homing sequences." />
                  </span>
                </label>
                {draft.forwardLimitAutosetEnable && (
                  <div className="cfg-field">
                    <div className="cfg-field-label">Auto-zero Value (rotations)</div>
                    <NumericInput className="cfg-input" step={0.01} value={draft.forwardLimitAutosetValue}
                      onChange={v => set('forwardLimitAutosetValue', v)} />
                  </div>
                )}
                <div className="cfg-field">
                  <div className="cfg-field-label">
                    Switch Type
                    <Tooltip text="NormallyOpen: open at rest, closes when triggered (most common). NormallyClosed: closed at rest, opens when triggered." />
                  </div>
                  <div className="cfg-tab-group">
                    {(['NormallyOpen', 'NormallyClosed'] as LimitType[]).map(t => (
                      <button key={t} className={`cfg-tab-btn ${draft.forwardLimitType === t ? 'active' : ''}`}
                        onClick={() => set('forwardLimitType', t)}>
                        {t === 'NormallyOpen' ? 'Normally Open' : 'Normally Closed'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="cfg-limit-group-label" style={{ marginTop: 12 }}>Reverse Limit</div>
            <label className="cfg-toggle">
              <input type="checkbox" checked={draft.reverseLimitEnable}
                onChange={e => set('reverseLimitEnable', e.target.checked)} />
              <span className="cfg-toggle-track" />
              <span className="cfg-toggle-label">
                Enable Reverse Limit
                <Tooltip text="When triggered, TalonFX cuts reverse motor output. Use to prevent over-retraction." />
              </span>
            </label>
            {draft.reverseLimitEnable && (
              <div className="cfg-subsection">
                <label className="cfg-toggle">
                  <input type="checkbox" checked={draft.reverseLimitAutosetEnable}
                    onChange={e => set('reverseLimitAutosetEnable', e.target.checked)} />
                  <span className="cfg-toggle-track" />
                  <span className="cfg-toggle-label">
                    Auto-zero on trigger
                    <Tooltip text="Resets the sensor position when the reverse limit trips." />
                  </span>
                </label>
                {draft.reverseLimitAutosetEnable && (
                  <div className="cfg-field">
                    <div className="cfg-field-label">Auto-zero Value (rotations)</div>
                    <NumericInput className="cfg-input" step={0.01} value={draft.reverseLimitAutosetValue}
                      onChange={v => set('reverseLimitAutosetValue', v)} />
                  </div>
                )}
                <div className="cfg-field">
                  <div className="cfg-field-label">
                    Switch Type
                    <Tooltip text="NormallyOpen: open at rest, closes when triggered. NormallyClosed: closed at rest, opens when triggered." />
                  </div>
                  <div className="cfg-tab-group">
                    {(['NormallyOpen', 'NormallyClosed'] as LimitType[]).map(t => (
                      <button key={t} className={`cfg-tab-btn ${draft.reverseLimitType === t ? 'active' : ''}`}
                        onClick={() => set('reverseLimitType', t)}>
                        {t === 'NormallyOpen' ? 'Normally Open' : 'Normally Closed'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Stall Detection ───────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">Stall Detection</div>
            <div className="cfg-row-3">
              <div className="cfg-field">
                <div className="cfg-field-label">
                  Stall Current (A)
                  <Tooltip text="Stator current above which the motor is considered potentially stalled. Set above free-spin current but below what a jammed mechanism draws." />
                </div>
                <NumericInput className="cfg-input" min={0} step={5} value={draft.stallCurrentThreshold}
                  onChange={v => set('stallCurrentThreshold', v)} />
              </div>
              <div className="cfg-field">
                <div className="cfg-field-label">
                  Stall Velocity (rot/s)
                  <Tooltip text="Rotor velocity below which the motor is considered stopped for stall detection. Increase if normal slow operation triggers false stall events." />
                </div>
                <NumericInput className="cfg-input" min={0} step={0.05} value={draft.stallVelocityThreshold}
                  onChange={v => set('stallVelocityThreshold', v)} />
              </div>
              <div className="cfg-field">
                <div className="cfg-field-label">
                  Stall Time (s)
                  <Tooltip text="How long the stall condition must persist before isStalled() returns true. Increase to debounce transient current spikes." />
                </div>
                <NumericInput className="cfg-input" min={0} step={0.05} value={draft.stallTimeSeconds}
                  onChange={v => set('stallTimeSeconds', v)} />
              </div>
            </div>
          </div>

          {/* ── Behavior ─────────────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">Behavior</div>
            <label className="cfg-toggle">
              <input type="checkbox" checked={draft.brakeMode} onChange={e => set('brakeMode', e.target.checked)} />
              <span className="cfg-toggle-track" />
              <span className="cfg-toggle-label">
                Brake Mode
                <Tooltip text="Brake: motor windings shorted when idle, actively resists motion. Coast: spins freely when idle. Use Brake for arms/elevators, Coast for flywheels." />
              </span>
            </label>
            {showContinuousWrap && (
              <label className="cfg-toggle">
                <input type="checkbox" checked={draft.continuousWrap} onChange={e => set('continuousWrap', e.target.checked)} />
                <span className="cfg-toggle-track" />
                <span className="cfg-toggle-label">
                  Continuous Wrap
                  <Tooltip text="Treats position as a continuous circle — the controller always takes the shortest path to the target. Use for swerve steer modules or any freely-rotating position-controlled mechanism." />
                </span>
              </label>
            )}
            <div className="cfg-field" style={{ marginTop: 8 }}>
              <div className="cfg-field-label">
                Sim Velocity RPS
                <Tooltip text="Simulation slew rate (rotations per second). Motor approaches its target at this rate in simulation instead of jumping instantly. 0 = instant response." />
              </div>
              <NumericInput className="cfg-input" min={0} step={0.01} value={draft.simVelocityRps}
                onChange={v => set('simVelocityRps', v)} />
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
