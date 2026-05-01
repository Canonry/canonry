import { Link } from '@tanstack/react-router'

interface BrandLockupProps {
  compact?: boolean
  version?: string
}

export function BrandLockup({ compact = false, version }: BrandLockupProps) {
  const showVersion = !compact && version && version !== 'unknown'
  return (
    <Link
      to="/"
      className={`brand-lockup ${compact ? 'brand-lockup-compact' : ''}`}
      aria-label="Canonry home"
    >
      <img className="brand-icon" src="./favicon.svg" alt="" aria-hidden="true" />
      <span className="brand-copy">
        <span className="brand-mark">Canonry</span>
        {showVersion ? <span className="brand-version">v{version}</span> : null}
      </span>
    </Link>
  )
}
