import { Link } from '@tanstack/react-router'
import { Bell, CalendarClock, LineChart, MapPin, Search, Terminal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * Where onboarding leaves off.
 *
 * The wizard used to end on a single "Open project dashboard" button, which
 * drops an operator into a ten-tab project with no idea which of them is worth
 * anything yet. Everything here is reachable from the project already; the
 * value is naming the handful that pay off first, once, at the moment the
 * operator is still in a setting-things-up frame of mind.
 *
 * Deliberately a divided list and not a grid of cards: DESIGN.md rules out
 * nesting cards and grids of identical cards, and a list of label/value/action
 * rows is what scans fastest anyway.
 */
export interface NextStep {
  id: string
  icon: LucideIcon
  label: string
  /** One line, in customer language, under 90 characters. */
  detail: string
  action: string
  /** A typed route, the way every other navigation in this app is written. */
  to?: string
  href?: string
}

export function buildNextSteps(): NextStep[] {
  return [
    {
      id: 'search-console',
      icon: Search,
      label: 'Search Console',
      detail: 'Compare answer engines with the queries you already rank for.',
      action: 'Connect',
      to: '/projects/$projectName/search-console',
    },
    {
      id: 'analytics',
      icon: LineChart,
      label: 'Google Analytics',
      detail: 'See the traffic answer engines actually send you.',
      action: 'Connect',
      to: '/projects/$projectName/activity',
    },
    {
      id: 'schedule',
      icon: CalendarClock,
      label: 'Scheduled checks',
      detail: 'Re-measure on a schedule instead of by hand.',
      action: 'Set up',
      to: '/projects/$projectName/settings',
    },
    {
      id: 'notifications',
      icon: Bell,
      label: 'Notifications',
      detail: 'Send a webhook when a check finishes or a score moves.',
      action: 'Set up',
      to: '/projects/$projectName/settings',
    },
    {
      id: 'local',
      icon: MapPin,
      label: 'Local presence',
      detail: 'Track the Google Business Profile behind local answers.',
      action: 'Open',
      to: '/projects/$projectName/local',
    },
    {
      id: 'agent',
      icon: Terminal,
      label: 'Your agent',
      detail: 'Read this project from Claude Code, Codex, or any MCP client.',
      action: 'Set up',
      to: '/agent-setup',
    },
  ]
}

export function NextSteps({ projectName }: { projectName: string }) {
  const steps = buildNextSteps()
  return (
    <section aria-labelledby="next-steps-heading" className="mt-6 border-t border-default pt-5">
      <h2 id="next-steps-heading" className="text-heading-14 text-heading">What else this project can do</h2>
      <ul className="mt-3 divide-y divide-default">
        {steps.map(({ id, icon: Icon, label, detail, action, to, href }) => (
          <li key={id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-3 sm:grid-cols-[auto_9rem_minmax(0,1fr)_auto] sm:gap-x-4">
            <Icon className="size-4 shrink-0 text-muted" aria-hidden="true" />
            <span className="text-label-14-strong text-heading">{label}</span>
            <span className="col-start-2 row-start-2 text-label-14 text-secondary sm:col-start-3 sm:row-start-1">{detail}</span>
            {to ? (
              <Link to={to} params={{ projectName }} className="col-start-3 row-start-1 justify-self-end text-label-14-strong text-link underline-offset-4 hover:underline sm:col-start-4">
                {action}
                <span className="sr-only"> {label}</span>
              </Link>
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="col-start-3 row-start-1 justify-self-end text-label-14-strong text-link underline-offset-4 hover:underline sm:col-start-4"
              >
                {action}
                <span className="sr-only"> {label}</span>
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
