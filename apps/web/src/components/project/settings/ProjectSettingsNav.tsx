import { Fragment, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useLinkProps, useLocation, useNavigate } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'

/** One section of project Settings: `id` is its anchor on the page. */
export interface ProjectSettingsEntry {
  id: string
  label: string
  content: ReactNode
}

// A jump lands a section under the topbar with a little air, and the same line decides which section the page is on.
// In less room the select sticks under the topbar, so the line is under the select. A jump made from the keys
// leaves the focus on the section, and the ring shows it.
const ANCHOR = 'rounded-sm scroll-mt-[calc(var(--topbar-h)+1rem)] max-[86rem]:scroll-mt-[calc(var(--topbar-h)+4.5rem)] focus:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 focus-visible:ring-offset-4 focus-visible:ring-offset-bg'
// A scroll has settled when no scroll event has come for this long.
const SETTLE_MS = 150
// How long a page that opened on a section is kept on it while the sections above load.
const STAY_MS = 3000
const READER_INPUTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
const LINK = 'block rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-surface hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:items-center'

/**
 * The section whose top has reached the jump line. At the end of the page the
 * last sections can never reach it, so there the last one is current.
 */
function sectionOnPage(ids: readonly string[]): string | undefined {
  const page = document.documentElement
  if (page.scrollHeight > window.innerHeight && window.innerHeight + window.scrollY >= page.scrollHeight - 2) return ids.at(-1)
  let current = ids[0]
  for (const id of ids) {
    const section = document.getElementById(id)
    if (!section) continue
    const line = Number.parseFloat(getComputedStyle(section).scrollMarginTop) || 0
    if (section.getBoundingClientRect().top - line <= 1) current = id
  }
  return current
}

/** `at once` skips the page's smooth scroll: for a page that opens on a section, and for keeping it there. */
function scrollToSection(id: string, atOnce = false): HTMLElement | null {
  const section = document.getElementById(id)
  // A DOM without layout has no such method.
  if (typeof section?.scrollIntoView === 'function') section.scrollIntoView(atOnce ? { behavior: 'instant' } : undefined)
  return section
}

/**
 * A jump is a real link to this page with the section as its hash. The router
 * marks every link to the open page as the current page, so the mark is set
 * here instead: one entry, the section the page is on.
 */
function SectionLink({ id, label, current, onJump }: { id: string; label: string; current: boolean; onJump: (id: string) => void }) {
  const link = useLinkProps({
    to: '.',
    search: true,
    hash: id,
    replace: true,
    // A click that opens the link in another tab or window leaves this page where it is.
    onClick: (event: MouseEvent) => {
      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) onJump(id)
    },
  })
  return (
    <a {...link} aria-current={current ? 'location' : undefined} className={`${LINK} ${current ? 'bg-surface font-medium text-heading' : 'text-secondary'}`}>
      {label}
    </a>
  )
}

/**
 * The jump list for project Settings: links in a column beside the page from
 * 86rem up, one select that stays under the topbar in less room. A jump
 * scrolls to the section, moves keyboard focus to it and puts it in the URL as
 * the hash, so a link to Settings can name a section. The list has no route
 * key of its own. The current entry follows the page as it scrolls.
 */
export function ProjectSettingsNav({ sections }: { sections: readonly Pick<ProjectSettingsEntry, 'id' | 'label'>[] }) {
  const navigate = useNavigate()
  const hash = useLocation({ select: location => location.hash })
  const ids = sections.map(section => section.id)
  const key = ids.join(' ')
  const [current, setCurrent] = useState<string | undefined>(ids[0])
  // A jump names its own section. Its scroll is smooth and passes the sections between, and the last ones never
  // reach the line, so the mark waits out the jump: until the page has been still for a moment.
  const heldUntil = useRef(0)
  const lastJump = useRef({ id: '', at: 0 })

  // A URL that names a section opens on it, also when the page drew after the router looked for it.
  useEffect(() => {
    if (!key.split(' ').includes(hash)) return
    heldUntil.current = Date.now() + SETTLE_MS
    setCurrent(hash)
    // A jump just made is already on its way there, smoothly.
    const jumping = lastJump.current.id === hash && Date.now() - lastJump.current.at < 1000
    if (!jumping) scrollToSection(hash, true)
    // The sections above may still be loading, and each one that lands pushes this one down the page. Stay
    // on it while the page settles, until the reader takes over or the page has had time to settle.
    const page = document.getElementById(hash)?.parentElement
    if (!page || typeof ResizeObserver === 'undefined') return
    let observed = false
    const stay = new ResizeObserver(() => {
      // The first report is the size as it stands, not a change.
      if (observed) {
        heldUntil.current = Date.now() + SETTLE_MS
        scrollToSection(hash, true)
      }
      observed = true
    })
    stay.observe(page)
    const release = () => stay.disconnect()
    for (const input of READER_INPUTS) window.addEventListener(input, release, { passive: true })
    const timer = window.setTimeout(release, STAY_MS)
    return () => {
      release()
      window.clearTimeout(timer)
      for (const input of READER_INPUTS) window.removeEventListener(input, release)
    }
  }, [hash, key])

  useEffect(() => {
    const list = key.split(' ')
    let frame = 0
    const follow = () => {
      if (Date.now() < heldUntil.current) {
        heldUntil.current = Date.now() + SETTLE_MS
        return
      }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setCurrent(sectionOnPage(list)))
    }
    // The wait is for the jump's own scroll. Once the reader takes over, the mark follows the page again.
    const release = () => { heldUntil.current = 0 }
    window.addEventListener('scroll', follow, { passive: true })
    for (const input of READER_INPUTS) window.addEventListener(input, release, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', follow)
      for (const input of READER_INPUTS) window.removeEventListener(input, release)
    }
  }, [key])

  // The keys go on from the section, as they do after a link to an anchor.
  const jump = (id: string) => {
    heldUntil.current = Date.now() + SETTLE_MS
    lastJump.current = { id, at: Date.now() }
    setCurrent(id)
    scrollToSection(id)?.focus({ preventScroll: true })
  }
  const shown = current !== undefined && ids.includes(current) ? current : ids[0]

  return (
    <nav aria-label="Settings sections" className="sticky top-[var(--topbar-h)] z-10 mt-2 bg-bg py-2 min-[86rem]:top-[calc(var(--topbar-h)+1rem)] min-[86rem]:z-auto min-[86rem]:mt-8 min-[86rem]:self-start min-[86rem]:bg-transparent min-[86rem]:py-0 min-[86rem]:pt-5">
      <div className="relative sm:max-w-xs min-[86rem]:hidden">
        <select
          aria-label="Settings section"
          className="h-11 w-full appearance-none rounded-md border border-default bg-surface/50 pl-3 pr-9 text-sm font-medium text-heading outline-none transition hover:border-strong focus-visible:border-mono-500 focus-visible:ring-1 focus-visible:ring-mono-500"
          value={shown}
          onChange={event => {
            const id = event.target.value
            jump(id)
            void navigate({ to: '.', search: true, hash: id, replace: true })
          }}
        >
          {sections.map(section => <option key={section.id} value={section.id}>{section.label}</option>)}
        </select>
        <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
      </div>
      <ul className="hidden space-y-0.5 min-[86rem]:block">
        {sections.map(section => (
          <li key={section.id}>
            <SectionLink id={section.id} label={section.label} current={section.id === shown} onJump={jump} />
          </li>
        ))}
      </ul>
    </nav>
  )
}

/**
 * Project Settings as one stacked page with its jump list. Every section sits
 * in its own anchor, in the order given, so the list names exactly what is on
 * the page. Without the list (an embed) the sections render as they are.
 */
export function ProjectSettingsLayout({ sections, nav }: { sections: readonly ProjectSettingsEntry[]; nav: boolean }) {
  if (!nav) return <>{sections.map(section => <Fragment key={section.id}>{section.content}</Fragment>)}</>
  return (
    // The list takes its column once the sections beside it keep 900px, the room their own headings need.
    // `--settings-stick` is where a header inside a section sticks: under the topbar, and under the select while that sticks there.
    <div className="[--settings-stick:calc(var(--topbar-h)_+_3.75rem)] min-[86rem]:grid min-[86rem]:grid-cols-[10rem_minmax(0,1fr)] min-[86rem]:gap-x-6 min-[86rem]:[--settings-stick:var(--topbar-h)]">
      <ProjectSettingsNav sections={sections} />
      <div className="min-w-0">
        {sections.map(section => <div key={section.id} id={section.id} tabIndex={-1} className={ANCHOR}>{section.content}</div>)}
      </div>
    </div>
  )
}
