import { useEffect, useState } from 'react'
import { ArrowUpRight, CircleCheck, X } from 'lucide-react'
import { dismissInstalledBuild, observeInstalledBuild, readInstalledUpdate, type InstalledBuild, type InstalledUpdate } from '../../lib/installed-update.js'
import { latestReleaseNotes, releaseChangesUrl, releaseHighlights } from '../../lib/release-notes.js'
import { Button } from '../ui/button.js'
import { BrandIcon } from './FooterLinks.js'

export function InstalledUpdateNotice({ build, storageKey, showResourceLinks = true, whatsNewOnly = false }: {
  build: InstalledBuild
  storageKey: string
  showResourceLinks?: boolean
  whatsNewOnly?: boolean
}) {
  const [notice, setNotice] = useState<InstalledUpdate | null>(null)
  const { version, commit } = build

  useEffect(() => {
    function sync(read: typeof observeInstalledBuild) {
      try {
        setNotice(read(window.localStorage, storageKey, { version, commit }))
      } catch {
        // Some browsers block access to localStorage itself.
        setNotice(null)
      }
    }
    function onStorage(event: StorageEvent) {
      if (event.key === storageKey || event.key === null) sync(readInstalledUpdate)
    }
    sync(observeInstalledBuild)
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [version, commit, storageKey])

  if (!notice || notice.current.version !== version) return null
  const { from, current } = notice
  const firstVisitRelease = !from || notice.includeFromHighlights
    ? latestReleaseNotes(from?.version ?? current.version, showResourceLinks)
    : undefined
  const highlights = from ? releaseHighlights(from.version, current.version, showResourceLinks) : []
  if (firstVisitRelease) highlights.push(...firstVisitRelease.highlights)
  if (highlights.length === 0 && (whatsNewOnly || !from)) return null

  // A first visit can feature an older release. Its package link must match the title.
  const linkedBuild: InstalledBuild = !from && firstVisitRelease && firstVisitRelease.version !== current.version.split('+', 1)[0]
    ? firstVisitRelease
    : current
  const title = whatsNewOnly ? 'What’s new' : from ? `Updated to v${current.version}` : `What’s new in v${linkedBuild.version}`
  const href = whatsNewOnly ? undefined : releaseChangesUrl(from?.commit, linkedBuild.commit, linkedBuild.version)

  function dismiss() {
    try {
      dismissInstalledBuild(window.localStorage, storageKey, version)
    } catch {
      // The close button also works if storage became unavailable.
    }
    setNotice(null)
  }

  return (
    <section role="status" aria-live="polite" className="toast-card toast-card-neutral" data-state="open">
      <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="toast-copy">
        <p className="toast-title">{title}</p>
        {highlights.length > 0 ? highlights.map(({ text }) => (
          <p key={text} className="mt-1 text-copy-13 text-secondary">{text}</p>
        )) : from && <p className="mt-1 text-copy-13 text-secondary">Previously v{from.version}.</p>}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 empty:hidden">
          {highlights.map(({ action }) => action && (
            <Button key={action.href} size="sm" asChild>
              <a href={action.href} target="_blank" rel="noopener noreferrer">
                <BrandIcon name={action.icon} />
                {action.label}
              </a>
            </Button>
          ))}
          {href && (
            <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-sm text-label-13 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2">
              {href.startsWith('https://github.com/') ? 'View changes' : 'View package on npm'}
              <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </a>
          )}
        </div>
      </div>
      <button type="button" className="toast-dismiss" aria-label={whatsNewOnly ? 'Dismiss what’s new' : 'Dismiss update notice'} onClick={dismiss}>
        <X aria-hidden="true" className="size-4" />
      </button>
    </section>
  )
}
