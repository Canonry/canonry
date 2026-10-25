import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { RunKinds, type RunDto } from '@canonry/canonry-contracts'
import { useDrawer } from '../../hooks/use-drawer.js'

/** SEO results have their own saved-scope workspace; other checks, and an SEO refresh that never started, use the run drawer. */
export function RunDetailLink({ run, projectName, children, className, label }: {
  run: Pick<RunDto, 'id' | 'kind' | 'projectId'> & { opensSeoWorkspace?: boolean }
  projectName?: string
  children: ReactNode
  className?: string
  label?: string
}) {
  const { openRun } = useDrawer()
  if (run.kind === RunKinds['seo-sync'] && run.opensSeoWorkspace !== false) {
    if (!projectName) return <button type="button" disabled className={className} aria-label={label} title="Project unavailable">{children}</button>
    return <Link
      to="/projects/$projectName/seo-data"
      params={{ projectName }}
      search={previous => ({ ...previous, seoRunId: run.id, seoProfileId: undefined, seoRegion: undefined, seoMarket: undefined, runId: undefined, evidenceId: undefined })}
      className={className}
      aria-label={label}
    >{children}</Link>
  }
  return <button type="button" className={className} aria-label={label} onClick={() => openRun(run.id)}>{children}</button>
}
