import { trackUiFilterChange } from '../../lib/ui-telemetry.js'

/**
 * The segmented time-window control shared by every metrics surface.
 *
 * Extracted because each surface previously declared its own option list and
 * rebuilt the same markup, so the control drifted between tabs even where the
 * ranges agreed. The allowed set stays a prop: surfaces genuinely differ in what
 * they can serve (Search Console holds full history, Google Ads reads a bounded
 * stored snapshot), and pretending otherwise would offer a range the data cannot
 * answer.
 */
export interface MetricsWindowPickerProps<TWindow extends string> {
  /** Options in display order. */
  windows: readonly TWindow[]
  value: TWindow
  onChange: (next: TWindow) => void
  /** Names the group for assistive tech, e.g. "Google Ads time period". */
  label: string
  /** Per-option display text. Defaults to the raw token ("7d"). */
  formatOption?: (window: TWindow) => string
  disabled?: boolean
}

export function MetricsWindowPicker<TWindow extends string>({
  windows,
  value,
  onChange,
  label,
  formatOption,
  disabled = false,
}: MetricsWindowPickerProps<TWindow>) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {windows.map((window) => (
        <button
          key={window}
          type="button"
          aria-pressed={value === window}
          disabled={disabled}
          className={`segmented-option ${value === window ? 'segmented-option-active' : ''}`}
          onClick={() => {
            if (window !== value) trackUiFilterChange('window')
            onChange(window)
          }}
        >
          {formatOption ? formatOption(window) : window}
        </button>
      ))}
    </div>
  )
}
