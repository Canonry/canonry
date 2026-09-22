import { visibilityReportRequestSchema, type AgentViewContext } from '@ainyc/canonry-contracts'
import { parseVisibilitySelection, visibilityReportFirstPageQuery } from './measurement-view-url.js'

export function aeroViewFromLocation(path: string, search: Record<string, unknown>): AgentViewContext {
  const property = /\/properties\/([^/]+)/.exec(path)
  const selection = parseVisibilitySelection(search)
  if (property) return { view: 'property', selection: visibilityReportRequestSchema.parse({ scope: 'property', scopeKey: decodeURIComponent(property[1]), queryClass: selection.queryClass, limit: 10 }) }
  if (path.endsWith('/technical-aeo')) return { view: 'site-health' }
  if (path.endsWith('/queries') && search.queryWorkspace === 'research') return { view: 'project' }
  const projectRoot = /^\/projects\/[^/]+\/?$/.test(path)
  if (projectRoot || path.endsWith('/queries')) {
    const parsed = visibilityReportRequestSchema.safeParse(visibilityReportFirstPageQuery(path.endsWith('/queries') ? { measurementScope: selection.measurementScope, measurementScopeKey: selection.measurementScopeKey, queryClass: selection.queryClass } : selection))
    return { view: projectRoot ? 'visibility' : 'queries', ...(parsed.success
      ? { selection: parsed.data }
      : { unavailableReason: 'The current measurement filters are invalid. Correct them before asking Aero about this view.' }) }
  }
  return { view: 'project' }
}
