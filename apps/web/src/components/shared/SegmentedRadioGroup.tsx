import type { KeyboardEvent } from 'react'

export interface SegmentedRadioOption<T extends string> {
  value: T
  label: string
}

/**
 * One choice of a few ("Non-brand | Branded", "7 days | 30 days"), as a
 * radiogroup with roving focus: arrow keys, Home and End move the choice and
 * the focus together. Shared by the AI Visibility cards so every class and
 * window control reads and behaves the same.
 */
export function SegmentedRadioGroup<T extends string>({
  options,
  value,
  onChange,
  label,
  className = '',
}: {
  options: readonly SegmentedRadioOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Names the group for assistive tech. */
  label: string
  className?: string
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = options.findIndex(option => option.value === value)
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = options.length - 1
    if (next === null) return
    event.preventDefault()
    onChange(options[next]!.value)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]!.focus()
  }

  return (
    <div role="radiogroup" aria-label={label} className={`segmented ${className}`.trim()} onKeyDown={handleKeyDown}>
      {options.map(option => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={`segmented-option min-h-11 ${checked ? 'segmented-option-active' : ''}`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
