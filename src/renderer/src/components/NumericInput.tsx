import { useState } from 'react'

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: number
  onChange: (value: number) => void
}

export default function NumericInput({ value, onChange, onFocus, onBlur, ...rest }: Props): JSX.Element {
  const [localText, setLocalText] = useState<string | null>(null)

  function handleFocus(e: React.FocusEvent<HTMLInputElement>): void {
    setLocalText(String(value))
    onFocus?.(e)
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setLocalText(e.target.value)
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>): void {
    if (localText !== null) {
      const parsed = parseFloat(localText)
      if (!isNaN(parsed)) onChange(parsed)
      // empty / invalid → do nothing; display reverts to parent value
    }
    setLocalText(null)
    onBlur?.(e)
  }

  return (
    <input
      type="number"
      value={localText !== null ? localText : value}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      {...rest}
    />
  )
}
