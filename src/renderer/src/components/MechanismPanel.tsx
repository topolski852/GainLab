import { MechanismConfig, MechanismType, MotorType } from '../types'
import { MOTORS, MOTOR_GROUPS, motorKvCTRE } from '../physics/motors'

interface Props {
  mechanism: MechanismConfig
  setpoint: number
  unitLabel: string
  onMechanismChange: (m: MechanismConfig) => void
  onSetpointChange: (v: number) => void
}

const MECH_TABS: { type: MechanismType; label: string }[] = [
  { type: 'flywheel', label: 'Flywheel' },
  { type: 'arm',      label: 'Arm' },
  { type: 'elevator', label: 'Elevator' }
]

export default function MechanismPanel({
  mechanism, setpoint, unitLabel, onMechanismChange, onSetpointChange
}: Props): JSX.Element {
  function set<K extends keyof MechanismConfig>(key: K, value: MechanismConfig[K]): void {
    onMechanismChange({ ...mechanism, [key]: value })
  }

  function numField(
    label: string,
    key: keyof MechanismConfig,
    unit: string,
    step = 0.01,
    min = 0
  ): JSX.Element {
    return (
      <div className="field" key={key}>
        <label className="field-label">{label}</label>
        <div className="field-row">
          <input
            type="number"
            className="input-num"
            value={mechanism[key] as number}
            step={step}
            min={min}
            onChange={e => set(key, parseFloat(e.target.value) || 0)}
          />
          <span className="field-unit">{unit}</span>
        </div>
      </div>
    )
  }

  const selectedMotor = MOTORS[mechanism.motorType]
  const showTrapWarning = mechanism.type === 'flywheel' && selectedMotor?.commutation === 'trapezoidal'

  return (
    <div className="mechanism-panel">
      <div className="panel-title">Mechanism</div>

      {/* Mechanism type tabs */}
      <div className="tab-group">
        {MECH_TABS.map(t => (
          <button
            key={t.type}
            className={`tab-btn ${mechanism.type === t.type ? 'active' : ''}`}
            onClick={() => set('type', t.type as MechanismType)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="section-divider" />

      {/* Motor selection */}
      <div className="section-label">Motor</div>
      <div className="field">
        <label className="field-label">Type</label>
        <select
          className="select"
          value={mechanism.motorType}
          onChange={e => set('motorType', e.target.value as MotorType)}
        >
          {MOTOR_GROUPS.map(group => (
            <optgroup key={group.label} label={group.label}>
              {group.ids.map(id => (
                <option key={id} value={id}>{MOTORS[id].name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* Live motor stats */}
      {selectedMotor && (
        <div className="motor-stats">
          <div className="motor-stat-row">
            <span className="motor-stat-key">Free Speed</span>
            <span className="motor-stat-val">{selectedMotor.freeSpeedRPM.toLocaleString()} RPM</span>
          </div>
          <div className="motor-stat-row">
            <span className="motor-stat-key">Stall Torque</span>
            <span className="motor-stat-val">{selectedMotor.stallTorqueNm.toFixed(2)} N·m</span>
          </div>
          <div className="motor-stat-row">
            <span className="motor-stat-key">Stall Current</span>
            <span className="motor-stat-val">{selectedMotor.stallCurrentA} A</span>
          </div>
          <div className="motor-stat-row">
            <span className="motor-stat-key">Peak Power</span>
            <span className="motor-stat-val">{selectedMotor.peakPowerW.toLocaleString()} W</span>
          </div>
          <div className="motor-stat-row">
            <span className="motor-stat-key">kV (P6)</span>
            <span className="motor-stat-val">{motorKvCTRE(selectedMotor).toFixed(4)} V·s/rot</span>
          </div>
          <div className="motor-stat-row">
            <span className="motor-stat-key">Kt</span>
            <span className="motor-stat-val">{(selectedMotor.KtNmPerAmp * 1000).toFixed(2)} mN·m/A</span>
          </div>
          <div className="motor-stat-row">
            <span className="motor-stat-key">Mass</span>
            <span className="motor-stat-val">{(selectedMotor.massKg * 1000).toFixed(0)} g</span>
          </div>
          <div className="motor-stat-row">
            <span className="motor-stat-key">Mode</span>
            <span className={`motor-stat-val ${selectedMotor.commutation === 'foc' ? 'stat-foc' : 'stat-trap'}`}>
              {selectedMotor.commutation === 'foc' ? 'FOC' : 'Trapezoidal'}
              {selectedMotor.id === 'minion' && ' ⚠'}
            </span>
          </div>
          {selectedMotor.id === 'minion' && (
            <div className="motor-stat-warning">
              ⚠ Some Minion specs are derived, not from published dyno data.
            </div>
          )}
        </div>
      )}

      {showTrapWarning && (
        <div className="motor-trap-warning">
          ⚠ Trapezoidal commutation causes speed ripple at high RPM.
          For shooters, use the FOC variant for consistent shot energy.
        </div>
      )}

      <div className="field">
        <label className="field-label">Count</label>
        <div className="count-group">
          {[1, 2, 3, 4].map(n => (
            <button
              key={n}
              className={`count-btn ${mechanism.numMotors === n ? 'active' : ''}`}
              onClick={() => set('numMotors', n)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {numField('Gear Ratio', 'gearRatio', ':1', 0.5, 0.1)}

      <div className="section-divider" />

      {/* Mechanism-specific params */}
      <div className="section-label">Parameters</div>
      {numField('Mass', 'massKg', 'kg', 0.1, 0.01)}

      {mechanism.type === 'flywheel' && (
        numField('Radius', 'radiusM', 'm', 0.01, 0.001)
      )}

      {mechanism.type === 'arm' && (<>
        {numField('Length', 'lengthM', 'm', 0.05, 0.1)}
        {numField('Start Angle', 'startAngleDeg', '°', 5, -180)}
      </>)}

      {mechanism.type === 'elevator' && (<>
        {numField('Spool Radius', 'spoolRadiusM', 'm', 0.005, 0.005)}
        {numField('Start Height', 'startHeightM', 'm', 0.05, 0)}
      </>)}

      <div className="section-divider" />

      {/* Setpoint */}
      <div className="section-label">Setpoint</div>
      <div className="field">
        <label className="field-label">
          {mechanism.type === 'flywheel' ? 'Target Velocity' :
           mechanism.type === 'arm'      ? 'Target Angle'    : 'Target Height'}
        </label>
        <div className="field-row">
          <input
            type="number"
            className="input-num"
            value={setpoint}
            step={mechanism.type === 'flywheel' ? 100 : mechanism.type === 'arm' ? 5 : 0.1}
            onChange={e => onSetpointChange(parseFloat(e.target.value) || 0)}
          />
          <span className="field-unit">{unitLabel}</span>
        </div>
      </div>

      {/* Control info */}
      <div className="section-divider" />
      <div className="info-box">
        <div className="info-row">
          <span className="info-key">Control Mode</span>
          <span className="info-val">
            {mechanism.type === 'flywheel' ? 'Velocity' : 'Position'}
          </span>
        </div>
        <div className="info-row">
          <span className="info-key">Feedforward</span>
          <span className="info-val">
            {mechanism.type === 'flywheel' ? 'kS + kV'           :
             mechanism.type === 'arm'      ? 'kS + kV + kG·cos θ' : 'kS + kV + kG'}
          </span>
        </div>
      </div>
    </div>
  )
}
