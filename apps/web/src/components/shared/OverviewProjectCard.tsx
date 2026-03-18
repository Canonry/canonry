import type { MouseEvent } from 'react'
import { ChevronRight } from 'lucide-react'
import type { PortfolioProjectVm } from '../../view-models.js'
import { toneFromRunStatus } from '../../lib/tone-helpers.js'
import { toTitleCase } from '../../lib/format-helpers.js'
import { Sparkline } from './Sparkline.js'

function createNavigationHandler(navigate: (to: string) => void, to: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    event.stopPropagation()
    navigate(to)
  }
}

export function OverviewProjectCard({
  project,
  onNavigate,
}: {
  project: PortfolioProjectVm
  onNavigate: (to: string) => void
}) {
  const projectPath = `/projects/${project.project.id}`

  return (
    <a
      className="project-row cursor-pointer"
      href={projectPath}
      onClick={createNavigationHandler(onNavigate, projectPath)}
    >
      <div className="project-row-primary">
        <div>
          <p className="project-name">{project.project.name}</p>
          <p className="project-domain">{project.project.canonicalDomain}</p>
        </div>
        <p className="project-insight">{project.insight}</p>
      </div>
      <div className="project-row-stat">
        <div className="metric-inline-block">
          <p className="metric-inline-label">Answer Visibility</p>
          <p className="metric-inline-value">{project.visibilityScore}</p>
          <p className="metric-inline-delta">{project.visibilityDelta}</p>
        </div>
      </div>
      <div className="project-row-stat">
        <div className="metric-inline-block">
          <p className="metric-inline-label">Competitor Pressure</p>
          <p className="metric-inline-value">{project.competitorPressureLabel}</p>
          <p className="metric-inline-delta">
            {project.lastRun.kindLabel} · {toTitleCase(project.lastRun.status)}
          </p>
        </div>
      </div>
      <div className="project-row-chart">
        <Sparkline points={project.trend} tone={toneFromRunStatus(project.lastRun.status)} />
      </div>
      <span className="project-row-link">
        <ChevronRight className="h-4 w-4 text-zinc-500" />
      </span>
    </a>
  )
}
