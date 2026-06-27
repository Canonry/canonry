import { expect, test } from 'vitest'

import {
  projectRouteSegmentFromPathname,
  resolveProjectNameForRouteSegment,
  resolveProjectNameFromPathname,
} from '../src/lib/project-route.js'
import type { DashboardVm, ProjectCommandCenterVm } from '../src/view-models.js'

function dashboard(projects: Array<Pick<ProjectCommandCenterVm['project'], 'id' | 'name'>>): DashboardVm {
  return {
    projects: projects.map(project => ({ project })),
  } as unknown as DashboardVm
}

test('projectRouteSegmentFromPathname decodes the canonical project-name segment', () => {
  expect(projectRouteSegmentFromPathname('/projects/acme-co/report')).toBe('acme-co')
  expect(projectRouteSegmentFromPathname('/projects/acme%20co/report')).toBe('acme co')
  expect(projectRouteSegmentFromPathname('/runs')).toBeNull()
})

test('resolveProjectNameForRouteSegment keeps name routes and maps stale id routes', () => {
  const data = dashboard([{ id: 'project-uuid', name: 'acme-co' }])

  expect(resolveProjectNameForRouteSegment('acme-co', data)).toBe('acme-co')
  expect(resolveProjectNameForRouteSegment('project-uuid', data)).toBe('acme-co')
  expect(resolveProjectNameForRouteSegment('new-project', null)).toBe('new-project')
})

test('resolveProjectNameFromPathname feeds project-name routes to project dashboard lookups', () => {
  const data = dashboard([{ id: 'project-uuid', name: 'az-coatings' }])

  expect(resolveProjectNameFromPathname('/projects/az-coatings', data)).toBe('az-coatings')
  expect(resolveProjectNameFromPathname('/projects/project-uuid/report', data)).toBe('az-coatings')
})
