import { Link } from '@tanstack/react-router'

export function BrandLockup({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      to="/"
      className={`brand-lockup ${compact ? 'brand-lockup-compact' : ''}`}
      aria-label="Canonry home"
    >
      <img className="brand-icon" src="./favicon.svg" alt="" aria-hidden="true" />
      <span className="brand-copy">
        <span className="brand-mark">Canonry</span>
        {compact ? null : <span className="brand-subtitle">AEO Operating System</span>}
      </span>
    </Link>
  )
}
