import type { HelpResult } from './dynamic-catalog.js'
import { OPERATIONS_GUIDE } from './operations-guide.generated.js'

export type GuideMode = 'hosted-fixed-catalog' | 'stdio-fixed-catalog' | 'stdio-progressive'

/** Local guidance only: never fetch data, load tools, or infer permissions. */
export function operationsHelp(catalog: HelpResult, mode: GuideMode, intent = '', includeCatalog = false) {
  const workflows = Object.keys(OPERATIONS_GUIDE.workflows) as Array<keyof typeof OPERATIONS_GUIDE.workflows>
  const words = new Set(intent.toLowerCase().split(/[^a-z0-9-]+/))
  const workflow = workflows.find(name => OPERATIONS_GUIDE.workflows[name].keywords.some(word => words.has(word))) ?? 'status'
  const route = OPERATIONS_GUIDE.workflows[workflow]
  const available = new Set([...catalog.coreTools, ...catalog.toolkits.filter(t => t.loaded).flatMap(t => t.tools)])
  const reads: readonly string[] = route.next
  const requestedActions: readonly string[] = 'actions' in route ? route.actions : []
  const next = reads.filter(name => available.has(name)).slice(0, 4)
  const actions = requestedActions.filter(name => available.has(name))
  // Keep project-based routes useful on specialist profiles without sending
  // projectless workflows through project selection.
  if (reads.includes('canonry_projects_list') && next.length < 2 && available.has('canonry_project_overview') && !next.includes('canonry_project_overview')) {
    next.push('canonry_project_overview')
  }
  const wanted = [...reads, ...requestedActions]
  const loadToolkits = mode === 'stdio-progressive'
    ? catalog.toolkits.filter(t => !t.loaded && t.tools.some(name => wanted.includes(name))).map(t => t.name)
    : []
  return {
    guideVersion: OPERATIONS_GUIDE.guideVersion,
    mode,
    scope: catalog.scope,
    workflow,
    next,
    ...(actions.length ? { actions } : {}),
    workflows,
    guidance: route.guidance,
    approvalBoundary: OPERATIONS_GUIDE.approvalBoundary,
    approvalRule: OPERATIONS_GUIDE.approvalRule,
    authority: OPERATIONS_GUIDE.authority,
    operationsGuideUrl: OPERATIONS_GUIDE.operationsGuideUrl,
    ...(loadToolkits.length ? { loadToolkits } : {}),
    ...(includeCatalog ? catalog : {}),
  }
}
