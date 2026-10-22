import { Fragment, useId, type KeyboardEvent } from 'react'

export interface SegmentedRadioOption<T extends string> {
  value: T
  label: string
  /** Read after the label by assistive tech, for a choice its label alone does not explain. On a disabled option it is also the hover title, so a mouse shows why. */
  description?: string
  /** Shown but not selectable; arrow keys pass over it. */
  disabled?: boolean
}

/**
 * One choice of a few ("Non-brand | Branded", "7 days | 30 days"), as a
 * radiogroup with roving focus: arrow keys, Home and End move the choice and
 * the focus together. Shared by the AI Visibility cards so every class,
 * metric and window control reads and behaves the same. Each option keeps the
 * compact height on a mouse and grows to a full touch target on a coarse pointer.
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
  const descriptionBaseId = useId()

  /** The first selectable option at `start` or beyond it in the `step` direction, wrapping once. */
  function selectableFrom(start: number, step: 1 | -1): number | null {
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (start + step * offset + options.length) % options.length
      if (!options[index]!.disabled) return index
    }
    return null
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = options.findIndex(option => option.value === value)
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = selectableFrom((index + 1) % options.length, 1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = selectableFrom((index - 1 + options.length) % options.length, -1)
    else if (event.key === 'Home') next = selectableFrom(0, 1)
    else if (event.key === 'End') next = selectableFrom(options.length - 1, -1)
    if (next === null) return
    event.preventDefault()
    onChange(options[next]!.value)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]!.focus()
  }

  return (
    <div role="radiogroup" aria-label={label} className={`segmented ${className}`.trim()} onKeyDown={handleKeyDown}>
      {options.map(option => {
        const checked = option.value === value
        const descriptionId = option.description ? `${descriptionBaseId}-${option.value}` : undefined
        return (
          <Fragment key={option.value}>
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              aria-describedby={descriptionId}
              aria-disabled={option.disabled || undefined}
              title={option.disabled ? option.description : undefined}
              tabIndex={checked ? 0 : -1}
              onClick={() => { if (!option.disabled) onChange(option.value) }}
              className={`segmented-option pointer-coarse:min-h-11 ${checked ? 'segmented-option-active' : ''}${option.disabled ? ' cursor-not-allowed opacity-50 hover:text-secondary' : ''}`}
            >
              {option.label}
            </button>
            {/* A sibling, not a child: inside the button it would join the option's name. */}
            {option.description ? <span id={descriptionId} className="sr-only">{option.description}</span> : null}
          </Fragment>
        )
      })}
    </div>
  )
}
