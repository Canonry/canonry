import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsByNameRunsOptions, getApiV1ProjectsByNameTechnicalAeoOptions } from '@ainyc/canonry-api-client/react-query'
import { ONBOARDING_FLOW_VERSION, RunKinds, RunStatuses, RunTriggers, type OnboardingNextAction } from '@ainyc/canonry-contracts'
import { ArrowRight, Bell, CalendarClock, Check, Copy, LineChart, MapPin, Search, Server } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { heyClient, recordOnboardingEvent } from '../api.js'
import { createOnboardingEventId, getOrCreateOnboardingSessionId } from '../lib/onboarding-telemetry.js'
import { addToast } from '../lib/toast-store.js'
import { OnboardingProgress, type OnboardingStage, type OnboardingStageOutcome } from '../components/shared/OnboardingProgress.js'
import { Button } from '../components/ui/button.js'

export const AGENT_MCP_INSTALL_COMMAND = 'canonry mcp install --client claude-code'
const AGENT_DOCS_URL = 'https://github.com/Canonry/canonry/blob/main/docs/mcp.md'

/**
 * Step 4: where every onboarding exit lands.
 *
 * Setup used to end on whatever screen the operator left from, which dropped
 * them into a ten-tab project with nothing saying what is worth doing next.
 * This page is the one moment they are still in a setting-things-up frame of
 * mind, so it names what pays off first: their agent, their data sources, and
 * the two things that keep Canonry running without them.
 *
 * The motion is the exception DESIGN.md allows for a finish line. Every
 * animation is gated on `prefers-reduced-motion: no-preference` in styles.css,
 * and the un-animated state is the finished frame, so nothing here depends on
 * motion to be read.
 */
/**
 * Finish-step telemetry. Rides the existing `onboarding.started` and
 * `onboarding.step_completed` events with `step: 'finish'`, because the
 * canonry.ai collector allowlists event NAMES and silently drops new ones.
 * Tagged `platform`: every path here starts at the first-run launchpad, and
 * the same session id ties it to that funnel. Each action is recorded once.
 */
function useFinishTelemetry() {
  const onboardingSessionId = useRef(getOrCreateOnboardingSessionId()).current
  const recorded = useRef(new Set<string>())
  const send = useCallback((key: string, event: Record<string, unknown>) => {
    if (recorded.current.has(key)) return
    recorded.current.add(key)
    void recordOnboardingEvent({
      ...event,
      flowVersion: ONBOARDING_FLOW_VERSION,
      onboardingSessionId,
      surface: 'platform',
      eventId: createOnboardingEventId(),
    } as Parameters<typeof recordOnboardingEvent>[0])
  }, [onboardingSessionId])
  useEffect(() => {
    send('started', { event: 'onboarding.started', step: 'finish', resumed: false })
  }, [send])
  return useCallback((nextAction: OnboardingNextAction) => {
    send(`action:${nextAction}`, { event: 'onboarding.step_completed', step: 'finish', method: 'manual', nextAction })
  }, [send])
}

const TrackNextAction = createContext<(action: OnboardingNextAction) => void>(() => {})

export function OnboardingCompletePage({
  projectName,
  skippedVisibility = false,
}: {
  projectName: string
  skippedVisibility?: boolean
}) {
  const scoreQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoOptions({ client: heyClient, path: { name: projectName } }),
    retry: false,
  })
  const score = scoreQuery.data?.hasData ? scoreQuery.data : null
  const trackNextAction = useFinishTelemetry()
  // Whether a scan happened is read from the project, not from how the operator
  // got here: every exit lands on this page, including ones before any scan.
  const scanRunsQuery = useQuery({
    ...getApiV1ProjectsByNameRunsOptions({
      client: heyClient,
      path: { name: projectName },
      query: { kind: RunKinds['site-audit'], limit: 20 },
    }),
    retry: false,
    // A scan still running when the operator got here finishes on its own;
    // re-read until it does, so the step turns complete without a reload.
    refetchInterval: (query) => siteScanOutcome(query.state.status === 'success'
      ? { isSuccess: true, data: query.state.data }
      : { isSuccess: false }) === 'pending' ? 5_000 : false,
  })
  const scanOutcome = siteScanOutcome(scanRunsQuery)
  const outcomes: Partial<Record<OnboardingStage, OnboardingStageOutcome>> = {
    ...(scanOutcome ? { site: scanOutcome, fixes: scanOutcome } : {}),
    ...(skippedVisibility ? { visibility: 'skipped' as const } : {}),
  }

  return (
    <TrackNextAction.Provider value={trackNextAction}>
    <div className="page-container max-w-6xl py-8 md:py-10">
      <OnboardingProgress current="done" outcomes={outcomes} />

      <header className="relative mx-auto mt-12 max-w-2xl text-center md:mt-16">
        <CheckBadge />
        <p className="onb-reveal mt-6 text-sm font-medium text-positive" style={delay(250)}>Setup complete</p>
        <h1 className="onb-reveal mt-2 text-5xl font-semibold tracking-tight text-heading md:text-6xl" style={delay(350)}>
          You&rsquo;re set.
        </h1>
        <p className="onb-reveal mx-auto mt-4 max-w-xl text-lg text-secondary" style={delay(450)}>
          Canonry is tracking <span className="font-medium text-heading">{projectName}</span>.
          Here&rsquo;s how to get the most out of it from here.
        </p>
      </header>

      <div className="mt-14 grid gap-4 md:grid-cols-6">
        <Tile className="md:col-span-4 md:row-span-2" delayMs={600} labelledBy="onb-agent-heading">
          <AgentTile projectName={projectName} />
        </Tile>
        <Tile className="md:col-span-2 md:row-span-2" delayMs={700} labelledBy="onb-data-heading">
          <DataTile projectName={projectName} />
        </Tile>
        <Tile className="md:col-span-3" delayMs={800} labelledBy="onb-schedule-heading">
          <ScheduleTile projectName={projectName} />
        </Tile>
        <Tile className="md:col-span-3" delayMs={900} labelledBy="onb-alerts-heading">
          <AlertsTile projectName={projectName} score={score?.aggregateScore ?? null} />
        </Tile>
      </div>

      <div className="onb-reveal mt-12 flex flex-col items-center gap-3 sm:flex-row sm:justify-center" style={delay(1000)}>
        <Button asChild className="h-11 rounded-full px-6 text-base md:h-11">
          <Link to="/projects/$projectName" params={{ projectName }} replace onClick={() => trackNextAction('open_project')}>
            Open {projectName}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </Button>
        <Button asChild variant="ghost" className="h-11 rounded-full px-5 md:h-11">
          <Link to="/projects/$projectName/technical-aeo" params={{ projectName }} replace onClick={() => trackNextAction('review_page_health')}>
            Review page health
          </Link>
        </Button>
      </div>
    </div>
    </TrackNextAction.Provider>
  )
}

/**
 * How the site scan ended, or `undefined` when it finished. Only a completed or
 * partial scan earns a check: a queued or running one is still in progress, a
 * failed one did not finish, and a history read that has not answered (or
 * failed) proves nothing either way.
 */
export function siteScanOutcome(query: {
  isSuccess: boolean
  data?: ReadonlyArray<{ trigger: string; status: string }>
}): OnboardingStageOutcome | undefined {
  if (!query.isSuccess || !query.data) return 'unknown'
  const scans = query.data.filter(run => run.trigger !== RunTriggers.probe)
  if (scans.some(run => run.status === RunStatuses.completed || run.status === RunStatuses.partial)) return undefined
  if (scans.some(run => run.status === RunStatuses.queued || run.status === RunStatuses.running)) return 'pending'
  return scans.length > 0 ? 'incomplete' : 'skipped'
}

function delay(ms: number): CSSProperties {
  return { '--onb-delay': `${ms}ms` } as CSSProperties
}

function CheckBadge() {
  return (
    <div className="onb-check relative mx-auto size-20" aria-hidden="true">
      <svg viewBox="0 0 80 80" className="relative size-20">
        <circle className="onb-check-ring" cx="40" cy="40" r="36" fill="none" strokeWidth="3" pathLength="1" />
        <path className="onb-check-mark" d="M25 41 L35 51 L56 30" fill="none" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" pathLength="1" />
      </svg>
    </div>
  )
}

function Tile({
  className = '',
  delayMs,
  labelledBy,
  children,
}: {
  className?: string
  delayMs: number
  labelledBy: string
  children: ReactNode
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={`onb-reveal onb-tile flex flex-col overflow-hidden rounded-2xl border border-default bg-surface p-6 md:p-7 ${className}`}
      style={delay(delayMs)}
    >
      {children}
    </section>
  )
}

function TileHeading({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{eyebrow}</p>
      <h2 id={id} className="mt-1.5 text-2xl font-semibold tracking-tight text-heading">{title}</h2>
      <p className="mt-2 text-sm text-secondary">{children}</p>
    </div>
  )
}

interface AgentSession {
  id: string
  label: string
  prompt: string
  calls: readonly string[]
  reply: string
}

/**
 * Illustrative sessions, labelled as examples in the UI. Every tool named here
 * is a real MCP tool, so what the window shows is what an agent actually does.
 */
const AGENT_SESSIONS: readonly AgentSession[] = [
  {
    id: 'diagnose',
    label: 'Diagnose',
    prompt: 'Why did we lose citations this week?',
    calls: ['canonry_insights_list', 'canonry_competitor_landscape'],
    reply: 'Two engines started citing a competitor’s comparison page instead of yours. Want me to draft one that answers the same query?',
  },
  {
    id: 'fix',
    label: 'Fix',
    prompt: 'Fix the weakest pages on the site.',
    calls: ['canonry_technical_aeo_pages', 'canonry_site_health_page_audit'],
    reply: 'The lowest-scoring pages are missing structured data and answer-first intros. I’ve written the changes for you to review.',
  },
  {
    id: 'automate',
    label: 'Automate',
    prompt: 'Re-check everything every Monday and tell me in Slack.',
    calls: ['canonry_schedule_set', 'canonry_agent_webhook_attach'],
    reply: 'Done. A sweep runs every Monday, and I’ll post what changed to Slack.',
  },
]

const SESSION_MS = 9000

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function AgentTile({ projectName }: { projectName: string }) {
  const trackNextAction = useContext(TrackNextAction)
  const [active, setActive] = useState(0)
  const [paused, setPaused] = useState(false)
  const [copied, setCopied] = useState(false)

  // Auto-advance is a demo, not content, so it stops the moment someone
  // hovers, focuses, or picks a session, and never runs under reduced motion.
  useEffect(() => {
    if (paused || prefersReducedMotion()) return
    const timer = window.setTimeout(() => setActive((index) => (index + 1) % AGENT_SESSIONS.length), SESSION_MS)
    return () => window.clearTimeout(timer)
  }, [active, paused])

  const copy = async () => {
    try {
      // `navigator.clipboard` is absent outside a secure context (plain http
      // on a LAN or Tailscale address), so reaching it can throw too.
      await navigator.clipboard.writeText(AGENT_MCP_INSTALL_COMMAND)
      trackNextAction('copy_agent_command')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      addToast({
        tone: 'negative',
        title: 'Could not copy the command',
        detail: `Run ${AGENT_MCP_INSTALL_COMMAND} in your terminal.`,
      })
    }
  }
  const session = AGENT_SESSIONS[active] ?? AGENT_SESSIONS[0]

  return (
    <>
      <TileHeading id="onb-agent-heading" eyebrow="Your agent" title="Let your agent run it.">
        Your agent can do everything in Canonry: diagnose a drop, fix pages, run sweeps and scans, and
        write the client report. Use Claude Code, Codex, Cursor, or Aero, the analyst built into{' '}
        <span className="text-heading">{projectName}</span> that reviews every sweep on its own.
      </TileHeading>

      <div
        className="mt-6 flex flex-1 flex-col rounded-xl border border-default bg-bg"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
      >
        <div className="flex items-center gap-1 border-b border-default px-3 py-2" role="tablist" aria-label="Example agent sessions">
          {AGENT_SESSIONS.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={index === active}
              onClick={() => { setActive(index); setPaused(true) }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                index === active ? 'bg-surface-inset text-heading' : 'text-muted hover:text-secondary'
              }`}
            >
              {item.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-faint">Example</span>
        </div>
        {/* Keyed on the session so each switch replays its own typing. */}
        <div key={session.id} role="tabpanel" aria-label={`${session.label} example`} className="flex-1 p-4 font-mono text-[13px] leading-relaxed">
          <p className="onb-type text-heading" style={delay(150)}>
            <span className="text-muted">&gt; </span>{session.prompt}
          </p>
          {session.calls.map((call, index) => (
            <p key={call} className="onb-line mt-1 text-muted first:mt-3" style={delay(1300 + index * 450)}>
              <span className="text-positive">●</span> {call}
            </p>
          ))}
          <p className="onb-line mt-3 text-secondary" style={delay(1500 + session.calls.length * 450)}>{session.reply}</p>
          <span className="onb-caret mt-2 inline-block h-4 w-2 bg-current align-middle text-secondary" style={delay(1900 + session.calls.length * 450)} aria-hidden="true" />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-default bg-surface-inset px-3 py-2 font-mono text-[13px] text-heading">
          {AGENT_MCP_INSTALL_COMMAND}
        </code>
        <Button type="button" variant="secondary" size="sm" className="h-9 md:h-9" onClick={() => { void copy() }}>
          {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <a href={AGENT_DOCS_URL} target="_blank" rel="noreferrer" className="text-sm font-medium text-link underline-offset-4 hover:underline">
          Other clients
        </a>
      </div>
    </>
  )
}

interface Destination {
  icon: LucideIcon
  label: string
  action: OnboardingNextAction
  to: '/projects/$projectName/search-console' | '/projects/$projectName/activity' | '/projects/$projectName/local' | '/projects/$projectName/settings'
}

const DATA_SOURCES: readonly Destination[] = [
  { icon: Search, label: 'Search Console', action: 'connect_search_console', to: '/projects/$projectName/search-console' },
  { icon: LineChart, label: 'Google Analytics', action: 'connect_analytics', to: '/projects/$projectName/activity' },
  { icon: MapPin, label: 'Business Profile', action: 'connect_business_profile', to: '/projects/$projectName/local' },
]

/** Real AI crawler user agents, the traffic server-side tracking exists to see. */
const AI_CRAWLERS = ['GPTBot', 'ClaudeBot', 'PerplexityBot'] as const

function DataTile({ projectName }: { projectName: string }) {
  const trackNextAction = useContext(TrackNextAction)
  return (
    <>
      <TileHeading id="onb-data-heading" eyebrow="Server-side traffic" title="See the AI bots.">
        AI crawlers and answer-engine fetches never run JavaScript, so Google Analytics never sees them.
        Canonry reads them straight from your server.
      </TileHeading>

      <CrawlerFlow />

      <Link
        to="/traffic"
        onClick={() => trackNextAction('connect_server_traffic')}
        aria-label="Connect server-side traffic"
        className="group flex items-center gap-3 rounded-xl border border-strong bg-surface-inset px-4 py-3 text-sm font-medium text-heading transition-colors hover:bg-surface-inset-hover"
      >
        <Server className="size-4 text-positive" aria-hidden="true" />
        <span className="flex-1">
          Connect your server
          <span className="block text-xs font-normal text-secondary">Cloudflare, Vercel, WordPress, or Cloud Run</span>
        </span>
        <ArrowRight className="size-4 text-link transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </Link>

      <p className="mt-5 text-xs font-medium uppercase tracking-wide text-muted">Also connect</p>
      <ul className="mt-1 divide-y divide-default">
        {DATA_SOURCES.map(({ icon: Icon, label, action, to }) => (
          <li key={label}>
            <Link
              to={to}
              params={{ projectName }}
              aria-label={`Connect ${label}`}
              onClick={() => trackNextAction(action)}
              className="group flex items-center gap-3 py-2.5 text-sm text-heading"
            >
              <Icon className="size-4 text-muted" aria-hidden="true" />
              <span className="flex-1">{label}</span>
              <ArrowRight className="size-3.5 text-link transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}

/** Crawlers hitting your server, and Canonry reading the server: the tile, drawn. */
function CrawlerFlow() {
  const rows = [22, 70, 118]
  return (
    <div className="relative my-6 h-36" aria-hidden="true">
      <svg viewBox="0 0 200 140" preserveAspectRatio="none" className="absolute inset-0 size-full">
        {rows.map((y, index) => (
          <path
            key={y}
            className="onb-flow"
            style={delay(index * 400)}
            d={`M20 ${y} C 100 ${y}, 118 70, 170 70`}
            fill="none"
            strokeWidth="1.5"
          />
        ))}
      </svg>
      {AI_CRAWLERS.map((name, index) => (
        <span
          key={name}
          className="onb-bot absolute left-0 -translate-y-1/2 rounded-md border border-default bg-bg-elevated px-2 py-1 font-mono text-[11px] text-secondary"
          style={{ top: `${((rows[index] ?? 70) / 140) * 100}%`, ...delay(index * 600) }}
        >
          {name}
        </span>
      ))}
      <span className="onb-hub absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-2xl bg-accent text-on-inverse">
        <Server className="size-5" />
      </span>
    </div>
  )
}

const WEEK = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

function ScheduleTile({ projectName }: { projectName: string }) {
  return (
    <>
      <TileHeading id="onb-schedule-heading" eyebrow="Scheduled sweeps" title="Runs on its own.">
        Re-measure every week without lifting a finger, so a drop shows up before a customer notices.
      </TileHeading>
      <ol className="mt-6 grid grid-cols-7 gap-2" aria-hidden="true">
        {WEEK.map((day, index) => (
          <li key={index} className="flex flex-col items-center gap-2">
            <span className="onb-day size-3 rounded-full bg-surface-inset" style={delay(index * 500)} />
            <span className="text-xs text-muted">{day}</span>
          </li>
        ))}
      </ol>
      <TileLink projectName={projectName} to="/projects/$projectName/settings" icon={CalendarClock} label="Set a schedule" action="set_schedule" />
    </>
  )
}

function AlertsTile({ projectName, score }: { projectName: string; score: number | null }) {
  return (
    <>
      <TileHeading id="onb-alerts-heading" eyebrow="Notifications" title="Hear about changes.">
        Get a webhook in Slack or anywhere else when a sweep finishes or a score moves.
      </TileHeading>
      <div className="relative mt-6 flex h-14 items-center" aria-hidden="true">
        <span className="onb-bell flex size-10 items-center justify-center rounded-full border border-default bg-bg-elevated">
          <Bell className="size-4 text-secondary" />
        </span>
        <span className="onb-toast ml-3 flex items-center gap-2 rounded-xl border border-default bg-bg-elevated px-3 py-2 text-sm shadow-[0_8px_24px_var(--color-shadow-panel)]">
          <span className="size-2 rounded-full bg-positive-400" />
          <span className="text-heading">{projectName}</span>
          <span className="text-secondary">{score === null ? 'sweep finished' : `page health ${score}`}</span>
        </span>
      </div>
      <TileLink projectName={projectName} to="/projects/$projectName/settings" icon={Bell} label="Add a notification" action="add_notification" />
    </>
  )
}

function TileLink({
  projectName,
  to,
  icon: Icon,
  label,
  action,
}: {
  projectName: string
  to: Destination['to']
  icon: LucideIcon
  label: string
  action: OnboardingNextAction
}) {
  const trackNextAction = useContext(TrackNextAction)
  return (
    <Link
      to={to}
      params={{ projectName }}
      onClick={() => trackNextAction(action)}
      className="group mt-6 inline-flex items-center gap-2 self-start text-sm font-medium text-link"
    >
      <Icon className="size-4" aria-hidden="true" />
      {label}
      <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
    </Link>
  )
}
