import type { MouseEvent } from 'react'
import { appHref } from '../../lib/base-path.js'

function createNavigationHandler(navigate: (to: string) => void, to: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    event.stopPropagation()
    navigate(to)
  }
}

export function BrandLockup({ compact = false, navigate }: { compact?: boolean; navigate: (to: string) => void }) {
  return (
    <a
      className={`brand-lockup ${compact ? 'brand-lockup-compact' : ''}`}
      href={appHref('/')}
      aria-label="Canonry home"
      onClick={createNavigationHandler(navigate, '/')}
    >
      <img className="brand-icon" src="./favicon.svg" alt="" aria-hidden="true" />
      <span className="brand-copy">
        <span className="brand-mark">Canonry</span>
        {compact ? null : <span className="brand-subtitle">AEO Monitor</span>}
      </span>
    </a>
  )
}
