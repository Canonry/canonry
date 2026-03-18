export function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="info-tooltip-wrapper">
      <svg className="info-tooltip-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 7v4M8 5.5v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span className="info-tooltip-bubble" role="tooltip">{text}</span>
    </span>
  )
}
