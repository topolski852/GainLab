import { useState, useEffect } from 'react'
import { RecentProject } from '../types'

interface Props {
  onNewProject: (name: string) => void
  onOpenProject: () => void
  onOpenRecent: (filePath: string) => void
  onRemoveRecent: (filePath: string) => void
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  return d.toLocaleDateString()
}

export default function Launcher({ onNewProject, onOpenProject, onOpenRecent, onRemoveRecent }: Props): JSX.Element {
  const [recent, setRecent] = useState<RecentProject[]>([])
  const [showNewForm, setShowNewForm] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    window.api?.getRecentProjects().then(setRecent).catch(() => {})
  }, [])

  function handleCreate(): void {
    const name = newName.trim()
    if (!name) return
    onNewProject(name)
  }

  function handleRemove(filePath: string, e: React.MouseEvent): void {
    e.stopPropagation()
    onRemoveRecent(filePath)
    setRecent(prev => prev.filter(r => r.filePath !== filePath))
  }

  return (
    <div className="launcher">
      <div className="launcher-header">
        <div className="launcher-logo">
          <span className="launcher-logo-gain">Gain</span>
          <span className="launcher-logo-lab">Lab</span>
        </div>
        <div className="launcher-tagline">FRC Motor Tuning Suite · Team 1507</div>
      </div>

      <div className="launcher-body">
        <div className="launcher-actions">
          {!showNewForm ? (
            <>
              <button className="launcher-btn launcher-btn-primary" onClick={() => setShowNewForm(true)}>
                <span className="launcher-btn-icon">+</span>
                New Project
              </button>
              <button className="launcher-btn launcher-btn-secondary" onClick={onOpenProject}>
                <span className="launcher-btn-icon">↗</span>
                Open Project
              </button>
            </>
          ) : (
            <div className="launcher-new-form">
              <div className="launcher-new-label">Project Name</div>
              <input
                className="launcher-new-input"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowNewForm(false) }}
                placeholder="e.g. Rebuilt2026"
                autoFocus
              />
              <div className="launcher-new-buttons">
                <button className="launcher-btn launcher-btn-primary" onClick={handleCreate} disabled={!newName.trim()}>
                  Create
                </button>
                <button className="launcher-btn launcher-btn-ghost" onClick={() => { setShowNewForm(false); setNewName('') }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="launcher-recent">
          <div className="launcher-recent-header">Recent Projects</div>
          {recent.length === 0 ? (
            <div className="launcher-recent-empty">No recent projects</div>
          ) : (
            <div className="launcher-recent-list">
              {recent.map(r => (
                <button
                  key={r.filePath}
                  className="launcher-recent-item"
                  onClick={() => onOpenRecent(r.filePath)}
                >
                  <div className="launcher-recent-name">{r.name}</div>
                  <div className="launcher-recent-meta">
                    <span>{r.motorCount} motor{r.motorCount !== 1 ? 's' : ''}</span>
                    <span className="launcher-recent-dot">·</span>
                    <span>{formatDate(r.updatedAt)}</span>
                  </div>
                  <div className="launcher-recent-path">{r.filePath}</div>
                  <button
                    className="launcher-recent-remove"
                    onClick={e => handleRemove(r.filePath, e)}
                    title="Remove from recent"
                  >
                    ×
                  </button>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
