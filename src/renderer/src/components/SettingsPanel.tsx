export type TextSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

export const TEXT_SIZE_LABELS: Record<TextSize, string> = {
  xs: 'Extra Small',
  sm: 'Small',
  md: 'Medium',
  lg: 'Large',
  xl: 'Extra Large',
}

// Preview pixel sizes are fixed — they show the scale comparison regardless of current setting
const PREVIEW_PX: Record<TextSize, number> = {
  xs: 11, sm: 14, md: 17, lg: 20, xl: 23,
}

interface Props {
  textSize: TextSize
  onTextSizeChange: (size: TextSize) => void
}

const SIZES: TextSize[] = ['xs', 'sm', 'md', 'lg', 'xl']

export default function SettingsPanel({ textSize, onTextSizeChange }: Props): JSX.Element {
  return (
    <div className="settings-panel">
      <div className="panel-title">Settings</div>
      <span className="section-label">Text Size</span>
      <div className="settings-size-list">
        {SIZES.map(size => (
          <button
            key={size}
            className={`settings-size-btn${textSize === size ? ' active' : ''}`}
            onClick={() => onTextSizeChange(size)}
          >
            <span className="settings-size-radio" />
            <span className="settings-size-name">{TEXT_SIZE_LABELS[size]}</span>
            <span
              className="settings-size-preview"
              style={{ fontSize: PREVIEW_PX[size] }}
            >
              Aa
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
