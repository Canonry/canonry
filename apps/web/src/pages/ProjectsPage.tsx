import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { StatusBadge } from '../components/shared/StatusBadge.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { YamlApplyPanel } from '../components/project/YamlApplyPanel.js'
import { createProject } from '../api.js'
import { useDashboard } from '../queries/use-dashboard.js'
import { Link } from '@tanstack/react-router'

export function ProjectsPage() {
  const { dashboard, isLoading, refetch } = useDashboard()

  if (!dashboard || isLoading) {
    return (
      <div className="page-skeleton">
        <div className="page-skeleton-header">
          <div className="skeleton-text h-6 w-28" />
          <div className="skeleton-text-sm w-40" />
        </div>
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 overflow-hidden">
          <div className="p-3 border-b border-zinc-800/60 flex gap-8">
            {['Name', 'Domain', 'Visibility', 'Last run', 'Country'].map((h) => (
              <div key={h} className="skeleton-text-sm w-16" />
            ))}
          </div>
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-3 border-b border-zinc-800/40 flex gap-8 items-center">
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
  const navigate = useNavigate()

  const [showForm, setShowForm] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [domain, setDomain] = useState('')
  const [country, setCountry] = useState('US')
  const [language, setLanguage] = useState('en')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')

  const handleCreate = async () => {
    if (!slug || !domain) return
    setSaving(true)
    setError(null)
    try {
      const project = await createProject(slug, {
        displayName: displayName || projectName,
        canonicalDomain: domain,
        country,
        language,
      })
      void refetch()
      setProjectName('')
      setDisplayName('')
      setDomain('')
      setCountry('US')
      setLanguage('en')
      setShowForm(false)
      navigate({ to: '/projects/$projectId', params: { projectId: project.id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Projects</h1>
          <p className="page-subtitle">{projects.length} project{projects.length !== 1 ? 's' : ''} tracked</p>
        </div>
        <div className="page-header-right">
          <Button type="button" onClick={() => setShowForm((v) => !v)}>
            <Plus className="size-4 mr-1.5" />
            Add project
          </Button>
        </div>
      </div>

      {showForm ? (
        <Card className="surface-card mb-6">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">New project</p>
              <h2 className="text-sm font-medium text-zinc-200">Create a new monitoring project</h2>
            </div>
          </div>
          <div className="compact-stack mt-4">
            <div className="setup-field-row">
              <div className="setup-field">
                <label className="setup-label" htmlFor="new-project-name">Project name</label>
                <input
                  id="new-project-name"
                  className="setup-input"
                  type="text"
                  placeholder="my-project"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                />
                {slug && slug !== projectName ? (
                  <p className="supporting-copy">Slug: {slug}</p>
                ) : null}
              </div>
              <div className="setup-field">
                <label className="setup-label" htmlFor="new-display-name">Display name</label>
                <input
                  id="new-display-name"
                  className="setup-input"
                  type="text"
                  placeholder="My Project"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
            </div>
            <div className="setup-field">
              <label className="setup-label" htmlFor="new-domain">Canonical domain</label>
              <input
                id="new-domain"
                className="setup-input"
                type="text"
                placeholder="example.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
              />
            </div>
            <div className="setup-field-row">
              <div className="setup-field">
                <label className="setup-label" htmlFor="new-country">Country</label>
                <input
                  id="new-country"
                  className="setup-input"
                  type="text"
                  placeholder="US"
                  maxLength={2}
                  value={country}
                  onChange={(e) => setCountry(e.target.value.toUpperCase())}
                />
              </div>
              <div className="setup-field">
                <label className="setup-label" htmlFor="new-language">Language</label>
                <input
                  id="new-language"
                  className="setup-input"
                  type="text"
                  placeholder="en"
                  maxLength={5}
                  value={language}
                  onChange={(e) => setLanguage(e.target.value.toLowerCase())}
                />
              </div>
            </div>
          </div>
          {error ? <p className="text-rose-400 text-sm mt-3">{error}</p> : null}
          <div className="flex items-center gap-3 mt-4">
            <Button type="button" disabled={!slug || !domain || saving} onClick={handleCreate}>
              {saving ? 'Creating...' : 'Create project'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      {projects.length > 0 ? (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Domain</th>
                <th>Visibility</th>
                <th>Last run</th>
                <th className="text-right">Country</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const latestRun = p.recentRuns[0]
                return (
                  <tr key={p.project.id} className="cursor-pointer" onClick={() => navigate({ to: '/projects/$projectId', params: { projectId: p.project.id } })}>
                    <td>
                      <Link
                        to="/projects/$projectId"
                        params={{ projectId: p.project.id }}
                        className="text-zinc-100 font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {p.project.displayName || p.project.name}
                      </Link>
                      <p className="text-[11px] text-zinc-500">{p.project.name}</p>
                    </td>
                    <td className="text-zinc-400">{p.project.canonicalDomain}</td>
                    <td>
                      <ToneBadge tone={p.visibilitySummary.tone}>{p.visibilitySummary.value}</ToneBadge>
                    </td>
                    <td className="text-zinc-500 text-sm">
                      {latestRun ? (
                        <StatusBadge status={latestRun.status} />
                      ) : (
                        <span className="text-zinc-600">No runs</span>
                      )}
                    </td>
                    <td className="text-right text-zinc-500">{p.project.country}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : !showForm ? (
        <Card className="surface-card empty-card">
          <h3>No projects yet</h3>
          <p className="supporting-copy">Create your first monitoring project to start tracking AI visibility.</p>
          <Button type="button" onClick={() => setShowForm(true)}>
            <Plus className="size-4 mr-1.5" />
            Add project
          </Button>
        </Card>
      ) : null}

      <YamlApplyPanel onApplied={() => { void refetch() }} />
    </div>
  )
}
