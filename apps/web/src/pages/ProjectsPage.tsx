import { Plus } from 'lucide-react'
import { Link, useNavigate } from '@tanstack/react-router'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { StatusBadge } from '../components/shared/StatusBadge.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { YamlApplyPanel } from '../components/project/YamlApplyPanel.js'
import { useAccount } from '../contexts/account-context.js'
import { useDashboardOverview as useDashboard } from '../queries/use-dashboard-overview.js'

export function ProjectsPage() {
  const { dashboard, isLoading, refetch } = useDashboard()
  const { canWrite, isAdmin } = useAccount()

  // Hooks run before the skeleton return for the reason described in
  // OverviewPage: React counts them by call order, so a return placed between
  // two of them changes the count between renders and throws.
  const navigate = useNavigate()

  if (!dashboard || isLoading) {
    return (
      <div className="page-skeleton">
        <div className="page-skeleton-header">
          <div className="skeleton-text h-6 w-28" />
          <div className="skeleton-text-sm w-40" />
        </div>
        <div className="rounded-xl border border-default bg-surface overflow-hidden">
          <div className="p-3 border-b border-default flex gap-8">
            {['Name', 'Domain', 'Mentions', 'Last run', 'Country'].map((h) => (
              <div key={h} className="skeleton-text-sm w-16" />
            ))}
          </div>
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-3 border-b border-subtle flex gap-8 items-center">
              <div className="flex-1 space-y-1">
                <div className="skeleton-text w-28" />
                <div className="skeleton-text-sm w-16" />
              </div>
              <div className="skeleton-text w-24" />
              <div className="skeleton h-5 w-14 rounded-full" />
              <div className="skeleton h-5 w-16 rounded-full" />
              <div className="skeleton-text-sm w-8" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const projects = dashboard.projects

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Projects</h1>
          <p className="page-subtitle">{projects.length} project{projects.length !== 1 ? 's' : ''} tracked</p>
        </div>
        {isAdmin ? <div className="page-header-right">
          <Button
            type="button"
            onClick={() => {
              void navigate({
                to: '/setup',
                search: { experience: 'platform' },
              })
            }}
          >
            <Plus className="size-4 mr-1.5" />
            {projects.length === 0 ? 'Map a site' : 'Add project'}
          </Button>
        </div> : null}
      </div>

      {projects.length > 0 ? (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Domain</th>
                <th>Mentions</th>
                <th>Last run</th>
                <th className="text-right">Country</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const latestRun = p.recentRuns[0]
                return (
                  <tr key={p.project.id} className="cursor-pointer" onClick={() => { void navigate({ to: '/projects/$projectName', params: { projectName: p.project.name } }) }}>
                    <td>
                      <Link
                        to="/projects/$projectName"
                        params={{ projectName: p.project.name }}
                        className="text-heading font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {p.project.displayName || p.project.name}
                      </Link>
                      <p className="text-[11px] text-muted">{p.project.name}</p>
                    </td>
                    <td className="text-secondary">{p.project.canonicalDomain}</td>
                    <td>
                      <ToneBadge tone={p.mentionSummary.tone}>{p.mentionSummary.value}</ToneBadge>
                    </td>
                    <td className="text-muted text-sm">
                      {latestRun ? (
                        <StatusBadge status={latestRun.status} />
                      ) : (
                        <span className="text-faint">No runs</span>
                      )}
                    </td>
                    <td className="text-right text-muted">{p.project.country}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Card className="surface-card empty-card">
          <h3>No projects yet</h3>
          <p className="supporting-copy">Map a public site to capture its Page Health baseline and exact fixes.</p>
          {isAdmin ? (
            <Button
              type="button"
              onClick={() => {
                void navigate({
                  to: '/setup',
                  search: { experience: 'platform' },
                })
              }}
            >
              <Plus className="size-4 mr-1.5" />
              Map a site
            </Button>
          ) : null}
        </Card>
      )}

      {/* Not gated on having projects: a FRESH install is exactly where pasting
          an existing canonry.yaml matters, and it is also where the inline
          create form is gone and "Map a site" is admin-only, so gating this
          left a non-admin writer with no way to create a project at all. */}
      {canWrite ? <YamlApplyPanel onApplied={() => { void refetch() }} /> : null}
    </div>
  )
}
