import { useState, useRef, useEffect } from 'react'
import { MotorProfile, Project } from '../types'

interface Props {
  project: Project
  activeMotorId: string | null
  onSelectMotor: (id: string) => void
  onAddMotor: () => void
  onConfigureMotor: (id: string) => void
  onRenameMotor: (id: string, name: string) => void
  onDeleteMotor: (id: string) => void
  onRenameProject: (name: string) => void
  onSave: () => void
  onClose: () => void
  isSaving: boolean
}

function mechIcon(motor: MotorProfile): string {
  if (motor.mechanism.type === 'flywheel') return '◎'
  if (motor.mechanism.type === 'arm') return '⌒'
  return '↕'
}

function mechColor(motor: MotorProfile): string {
  if (motor.mechanism.type === 'flywheel') return 'var(--blue-bright)'
  if (motor.mechanism.type === 'arm') return '#f0a529'
  return 'var(--success)'
}

export default function ProjectSidebar({
  project, activeMotorId,
  onSelectMotor, onAddMotor, onConfigureMotor,
  onRenameMotor, onDeleteMotor, onRenameProject,
  onSave, onClose, isSaving,
}: Props): JSX.Element {
  const [contextId, setContextId] = useState<string | null>(null)
  const [contextPos, setContextPos] = useState({ x: 0, y: 0 })
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renamingProject, setRenamingProject] = useState(false)
  const [projectNameValue, setProjectNameValue] = useState(project.name)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!contextId) return
    function handler(e: MouseEvent): void {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextId(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextId])

  useEffect(() => {
    if (renamingId !== null && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  // Keep display name in sync when project renames externally
  useEffect(() => { setProjectNameValue(project.name) }, [project.name])

  function startRename(motor: MotorProfile, e: React.MouseEvent): void {
    e.stopPropagation()
    setContextId(null)
    setRenamingId(motor.id)
    setRenameValue(motor.name)
  }

  function commitRename(): void {
    if (renamingId && renameValue.trim()) {
      onRenameMotor(renamingId, renameValue.trim())
    }
    setRenamingId(null)
  }

  function handleContextMenu(motor: MotorProfile, e: React.MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    setContextId(motor.id)
    setContextPos({ x: e.clientX, y: e.clientY })
  }

  function commitProjectRename(): void {
    if (projectNameValue.trim()) onRenameProject(projectNameValue.trim())
    else setProjectNameValue(project.name)
    setRenamingProject(false)
  }

  return (
    <div className="project-sidebar">
      {/* Header */}
      <div className="project-sidebar-header">
        <div className="project-header-left">
          {renamingProject ? (
            <input
              className="project-name-input"
              value={projectNameValue}
              onChange={e => setProjectNameValue(e.target.value)}
              onBlur={commitProjectRename}
              onKeyDown={e => {
                if (e.key === 'Enter') commitProjectRename()
                if (e.key === 'Escape') { setProjectNameValue(project.name); setRenamingProject(false) }
              }}
              autoFocus
            />
          ) : (
            <button
              className="project-name-btn"
              onDoubleClick={() => { setProjectNameValue(project.name); setRenamingProject(true) }}
              title="Double-click to rename"
            >
              {project.name}
            </button>
          )}
          <span className="project-motor-count">
            {project.motors.length} motor{project.motors.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="project-header-actions">
          <button className="sidebar-icon-btn" onClick={onSave} disabled={isSaving} title="Save project">
            {isSaving ? '…' : '⤓'}
          </button>
          <button className="sidebar-icon-btn sidebar-icon-btn-close" onClick={onClose} title="Close project">
            ×
          </button>
        </div>
      </div>

      {/* Motor list */}
      <div className="project-sidebar-section-label">MOTORS</div>
      <div className="project-motor-list">
        {project.motors.length === 0 && (
          <div className="project-empty">No motors yet. Click + Add Motor below.</div>
        )}
        {project.motors.map(motor => (
          <div
            key={motor.id}
            className={`project-motor-row ${activeMotorId === motor.id ? 'active' : ''}`}
            onClick={() => { setContextId(null); onSelectMotor(motor.id) }}
            onContextMenu={e => handleContextMenu(motor, e)}
          >
            <span className="project-motor-icon" style={{ color: mechColor(motor) }}>
              {mechIcon(motor)}
            </span>
            {renamingId === motor.id ? (
              <input
                ref={renameInputRef}
                className="project-rename-input"
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenamingId(null) }}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <div className="project-motor-info">
                <span className="project-motor-name">{motor.name}</span>
                <span className="project-motor-meta">
                  {motor.mechanism.type} · CAN {motor.canId}
                </span>
                {motor.tuneStatus === 'tuned' && motor.tuneBestScore != null && (
                  <span className="project-motor-tuned">✓ Tuned · {motor.tuneBestScore.toFixed(2)}</span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add motor button */}
      <div className="project-sidebar-footer">
        <button className="project-add-btn" onClick={onAddMotor}>+ Add Motor</button>
      </div>

      {/* Context menu */}
      {contextId && (
        <div
          ref={contextMenuRef}
          className="project-context-menu"
          style={{ position: 'fixed', left: contextPos.x, top: contextPos.y }}
        >
          <button onClick={() => { setContextId(null); onConfigureMotor(contextId) }}>
            Configure
          </button>
          <button onClick={e => {
            const m = project.motors.find(m => m.id === contextId)
            if (m) startRename(m, e)
          }}>
            Rename
          </button>
          <div className="project-context-divider" />
          <button
            className="project-context-danger"
            onClick={() => { setContextId(null); onDeleteMotor(contextId) }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
