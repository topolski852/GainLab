import { ConnectionMode, ConnectionStatus } from '../types'

interface Props {
  connectionMode: ConnectionMode
  connectionStatus: ConnectionStatus
  teamNumber: string
  testCount: number
  onTeamNumberChange: (t: string) => void
  onConnect: () => void
  onDisconnect: () => void
  onSwitchToSim: () => void
}

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Error'
}

const STATUS_CLASSES: Record<ConnectionStatus, string> = {
  disconnected: 'status-dot--off',
  connecting: 'status-dot--pulse',
  connected: 'status-dot--on',
  error: 'status-dot--err'
}

export default function StatusBar({
  connectionMode, connectionStatus, teamNumber, testCount,
  onTeamNumberChange, onConnect, onDisconnect, onSwitchToSim
}: Props): JSX.Element {
  const isLive = connectionMode === 'live'
  const isConnected = connectionStatus === 'connected'

  return (
    <div className="status-bar">
      {/* Left: mode + connection */}
      <div className="status-left">
        <div className={`mode-badge ${isLive ? 'mode-live' : 'mode-sim'}`}>
          {isLive ? 'LIVE' : 'SIM'}
        </div>
        <div className={`status-dot ${STATUS_CLASSES[connectionStatus]}`} />
        <span className="status-label">{STATUS_LABELS[connectionStatus]}</span>
      </div>

      {/* Center: NT4 controls */}
      <div className="status-center">
        {isLive && isConnected ? (
          <>
            <span className="nt4-info">
              10.{parseInt(teamNumber, 10) > 99
                ? `${Math.floor(parseInt(teamNumber, 10) / 100)}.${parseInt(teamNumber, 10) % 100}`
                : `0.${teamNumber}`}.2:5810
            </span>
            <button className="status-btn status-btn--danger" onClick={onDisconnect}>
              Disconnect
            </button>
            <button className="status-btn" onClick={onSwitchToSim}>
              Switch to Sim
            </button>
          </>
        ) : (
          <>
            <span className="nt4-label">Team</span>
            <input
              type="text"
              className="team-input"
              value={teamNumber}
              maxLength={4}
              placeholder="1507"
              onChange={e => onTeamNumberChange(e.target.value.replace(/\D/g, ''))}
            />
            <button
              className={`status-btn status-btn--primary ${connectionStatus === 'connecting' ? 'loading' : ''}`}
              onClick={isLive ? onDisconnect : onConnect}
              disabled={connectionStatus === 'connecting' || teamNumber.length < 1}
            >
              {connectionStatus === 'connecting' ? 'Connecting…' : isLive ? 'Reconnect' : 'Connect to Robot'}
            </button>
            {isLive && (
              <button className="status-btn" onClick={onSwitchToSim}>
                Sim Mode
              </button>
            )}
          </>
        )}
      </div>

      {/* Right: test counter + branding */}
      <div className="status-right">
        <span className="test-counter">
          {testCount > 0 ? `${testCount} test${testCount !== 1 ? 's' : ''}` : 'No tests yet'}
        </span>
        <span className="branding">GainLab · Team 1507</span>
      </div>
    </div>
  )
}
