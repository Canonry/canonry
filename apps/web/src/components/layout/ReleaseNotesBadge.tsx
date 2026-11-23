import { useEffect, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRight, ChevronDown, X } from 'lucide-react'
import { markReleaseRead, observeReleaseNotes } from '../../lib/installed-update.js'
import type { ReleaseNotes } from '../../lib/release-notes.js'
import type { UpdateAvailable } from '../../view-models.js'
import { Button } from '../ui/button.js'
import { BrandIcon } from './FooterLinks.js'

export function AvailableUpdateBadge({ update, onDismiss }: { update: UpdateAvailable; onDismiss: () => void }) {
  return (
    <span data-dashboard-release-control="" className="brand-update-bubble" role="status">
      <a href={update.url} target="_blank" rel="noopener noreferrer" className="brand-update-bubble-link"
        title={`Open release: ${update.upgradeCommand}`} aria-label={`New version v${update.latest} available. Open release page`}>
        <span className="brand-update-bubble-from">v{update.current}</span>
        <ArrowRight className="brand-update-bubble-arrow size-3" aria-hidden="true" />
        <span className="brand-update-bubble-to">v{update.latest}</span>
      </a>
      <button type="button" className="brand-update-bubble-dismiss" onClick={onDismiss}
        aria-label={`Dismiss update notification for v${update.latest}`}>
        <X className="size-3" aria-hidden="true" />
      </button>
    </span>
  )
}

function browserStorage(): Storage | undefined {
  try { return window.localStorage } catch { return undefined }
}

export function ReleaseNotesBadge({ build, storageKey, showResourceLinks, whatsNewOnly, availableUpdate }: {
  build: { version: string }
  storageKey: string
  showResourceLinks: boolean
  whatsNewOnly: boolean
  availableUpdate?: ReactNode
}) {
  const [notes, setNotes] = useState<ReturnType<typeof observeReleaseNotes>>({ releases: [], unread: false })
  const [opened, setOpened] = useState<ReleaseNotes[] | null>(null)
  const { version } = build

  useEffect(() => {
    const refresh = () => setNotes(observeReleaseNotes(browserStorage(), storageKey, version, showResourceLinks))
    function sync(event: StorageEvent) {
      if (event.key === null || event.key === storageKey || event.key.startsWith(storageKey + ':')) refresh()
    }
    refresh()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [version, storageKey, showResourceLinks])

  if (!opened && availableUpdate) return <>{availableUpdate}</>
  if (!notes.releases.length) return null

  function changeOpen(open: boolean) {
    if (!open) {
      setOpened(null)
      return
    }
    // Keep what the user opened on screen when reads arrive from another tab.
    setOpened(notes.releases)
    const storage = browserStorage()
    let persisted = true
    if (storage) {
      for (const release of notes.releases) {
        if (!markReleaseRead(storage, storageKey, release.version)) persisted = false
      }
    }
    setNotes(observeReleaseNotes(persisted ? storage : undefined, storageKey, version, showResourceLinks))
  }

  return (
    <Dialog.Root open={opened !== null} onOpenChange={changeOpen} modal={false}>
      <div data-dashboard-release-control="" className="lg:relative">
        <Dialog.Trigger asChild>
          <Button type="button" variant="ghost" size="sm" className="gap-1.5 px-2 data-[state=open]:bg-bg-elevated"
            aria-label={notes.unread ? 'What’s new, unread release notes' : 'What’s new'}>
            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full bg-caution-fill ${notes.unread ? '' : 'invisible'}`} />
            What’s new
            <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
          </Button>
        </Dialog.Trigger>
        <Dialog.Content aria-describedby={undefined}
          className="material-menu absolute right-3 top-full z-50 mt-1.5 max-h-[60dvh] w-[min(310px,calc(100vw-24px))] overflow-y-auto p-4 lg:right-0">
          <div className="flex items-center gap-2">
            <Dialog.Title className="text-heading-16 text-primary">What’s new</Dialog.Title>
            {!whatsNewOnly && opened?.length === 1 && <span className="text-label-12-mono text-secondary">v{opened[0]!.version}</span>}
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" className="-my-1.5 -mr-1.5 ml-auto size-8" aria-label="Close release notes">
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          {opened?.map(release => (
            <div key={release.version} className="mt-3 space-y-3">
              {!whatsNewOnly && opened.length > 1 && <p className="text-label-12-mono text-secondary">v{release.version}</p>}
              {release.highlights.map(highlight => (
                <div key={highlight.text}>
                  {highlight.title && <h3 className="mb-1 text-label-14-strong text-primary">{highlight.title}</h3>}
                  <p className="text-copy-14 text-secondary">{highlight.text}</p>
                  {highlight.action && (
                    <Button asChild size="sm" className="mt-3">
                      <a href={highlight.action.href} target="_blank" rel="noopener noreferrer">
                        <BrandIcon name={highlight.action.icon} />{highlight.action.label}
                      </a>
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </Dialog.Content>
      </div>
    </Dialog.Root>
  )
}
