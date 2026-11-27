import type { KeyboardEvent } from 'react'

/** Horizontal workspace tabs with automatic activation and a single tab stop. */
export function WorkspaceTabs<T extends string>({
  id, label, options, value, onChange, className, tabClassName, activeTabClassName, inactiveTabClassName = '',
}: {
  id: string
  label: string
  options: readonly (readonly [T, string])[]
  value: T
  onChange: (value: T) => void
  className: string
  tabClassName: string
  activeTabClassName: string
  /** Classes only the unselected tabs take, such as a hover state the selected tab must not show. */
  inactiveTabClassName?: string
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = options.findIndex(([key]) => key === value)
    let next: number
    switch (event.key) {
      case 'ArrowRight': next = (index + 1) % options.length; break
      case 'ArrowLeft': next = (index - 1 + options.length) % options.length; break
      case 'Home': next = 0; break
      case 'End': next = options.length - 1; break
      default: return
    }
    event.preventDefault()
    onChange(options[next]![0])
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]!.focus()
  }

  return (
    <div role="tablist" aria-label={label} className={className} onKeyDown={handleKeyDown}>
      {options.map(([key, name]) => (
        <button
          key={key}
          id={`${id}-${key}`}
          type="button"
          role="tab"
          aria-selected={value === key}
          aria-controls={`${id}-panel`}
          tabIndex={value === key ? 0 : -1}
          className={`${tabClassName} ${value === key ? activeTabClassName : inactiveTabClassName}`}
          onClick={() => onChange(key)}
        >
          {name}
        </button>
      ))}
    </div>
  )
}
