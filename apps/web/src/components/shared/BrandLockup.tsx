import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight, X } from 'lucide-react'
import { dashboardShowsIconMark } from '../../api.js'
import type { UpdateAvailable } from '../../view-models.js'

interface BrandLockupProps {
  compact?: boolean
  version?: string
  updateAvailable?: UpdateAvailable | null
  onDismissUpdate?: () => void
}

const BUBBLE_EXIT_MS = 220

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

export function BrandLockup({ compact = false, version, updateAvailable, onDismissUpdate }: BrandLockupProps) {
  const showVersion = !compact && version && version !== 'unknown'
  // Local closing state so we can play the exit animation before the parent
  // unmounts the bubble. Without this the bubble vanishes the instant React
  // re-renders with updateAvailable=null.
  const [closing, setClosing] = useState(false)
  // Bubble only renders in the sidebar (non-compact) layout — the topbar
  // mobile lockup has no room for it.
  const showBubble = !compact && updateAvailable && onDismissUpdate

  const handleDismiss = () => {
    setClosing(true)
    window.setTimeout(() => {
      onDismissUpdate?.()
      // Reset so a future updateAvailable (next version released) animates in fresh.
      setClosing(false)
    }, BUBBLE_EXIT_MS)
  }

  // Compact lockup (mobile topbar) keeps the original simple Link structure —
  // no bubble support, no nested clickables to worry about.
  if (compact) {
    return (
      <Link
        to="/"
        className="brand-lockup brand-lockup-compact"
        aria-label="Canonry home"
      >
        <BrandMarkImage className="brand-icon" />
        <span className="brand-copy">
          <span className="brand-mark">Canonry</span>
        </span>
      </Link>
    )
  }

  // Sidebar layout: split the Links so the version notification can host
  // interactive elements without nesting <a>/<button> inside another <a>.
  // The bubble spans the whole lockup below the wordmark, keeping long version
  // strings within the sidebar instead of squeezing them beside the mascot.
  return (
    <div className="brand-lockup brand-lockup-wrapper">
      <Link
        to="/"
        className="brand-icon-link"
        aria-label="Canonry home"
        tabIndex={-1}
      >
        <BrandMarkImage className="brand-icon" />
      </Link>
      <div className="brand-copy">
        <Link to="/" className="brand-mark">Canonry</Link>
        {!showBubble && showVersion ? (
          <span className="brand-version">v{version}</span>
        ) : null}
      </div>
      {showBubble ? (
        <span
          className={`brand-update-bubble ${closing ? 'brand-update-bubble-closing' : ''}`}
          role="status"
          aria-live="polite"
        >
          <a
            className="brand-update-bubble-link"
            href={updateAvailable.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open release: ${updateAvailable.upgradeCommand}`}
            aria-label={`New version v${updateAvailable.latest} available — open release page`}
          >
            <span className="brand-update-bubble-from">v{updateAvailable.current}</span>
            <ArrowRight className="brand-update-bubble-arrow size-3" aria-hidden="true" />
            <span className="brand-update-bubble-to">v{updateAvailable.latest}</span>
          </a>
          <button
            type="button"
            className="brand-update-bubble-dismiss"
            onClick={handleDismiss}
            aria-label={`Dismiss update notification for v${updateAvailable.latest}`}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ) : null}
    </div>
  )
}
