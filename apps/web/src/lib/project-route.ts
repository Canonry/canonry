import type { DashboardVm } from '../view-models.js'

export function projectRouteSegmentFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return match[1]!
  }
}

export function resolveProjectNameForRouteSegment(
  segment: string | null,
  dashboard: DashboardVm | null | undefined,
): string | null {
  if (!segment) return null
  const project = dashboard?.projects.find(p =>
    p.project.name === segment || p.project.id === segment,
  )
  return project?.project.name ?? segment
}

export function resolveProjectNameFromPathname(
  pathname: string,
  dashboard: DashboardVm | null | undefined,
): string | null {
  return resolveProjectNameForRouteSegment(
    projectRouteSegmentFromPathname(pathname),
    dashboard,
  )
}
