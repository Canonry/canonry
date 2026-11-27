import { Link } from '@tanstack/react-router'
import { dashboardShowsIconMark } from '../../api.js'

interface BrandLockupProps {
  compact?: boolean
  version?: string
}

/**
 * The Canonry mark beside the wordmark. Deployments with `dashboard.brandMark:
 * icon` (client instances) show the plugin icon, whose white tile keeps its
 * edge on light surfaces through `.brand-icon-tile`; the rest show the mascot.
 */
export function BrandMarkImage({ className }: { className: string }) {
  const icon = dashboardShowsIconMark()
  return (
    <img
      className={icon ? `${className} brand-icon-tile` : className}
      src={icon ? './canonry-icon.svg' : './favicon.svg'}
      alt=""
      aria-hidden="true"
    />
  )
}

export function BrandLockup({ compact = false, version }: BrandLockupProps) {
  return (
    <Link to="/" className={compact ? 'brand-lockup brand-lockup-compact' : 'brand-lockup'} aria-label="Canonry overview">
      <BrandMarkImage className="brand-icon" />
      <span className="brand-copy">
        <span className="brand-mark">Canonry</span>
        {!compact && version && version !== 'unknown' && <span className="brand-version">v{version}</span>}
      </span>
    </Link>
  )
}
