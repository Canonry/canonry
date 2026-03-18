import { useNavigate, useSearch, useRouterState } from '@tanstack/react-router'
import { rootRoute } from '../router/routes.js'

export function useDrawer() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { runId?: string; evidenceId?: string }
  const currentPath = useRouterState({ select: (s) => s.location.pathname })
  const runId = search.runId ?? null
  const evidenceId = search.evidenceId ?? null

  const openRun = (id: string) =>
    navigate({ to: currentPath, from: rootRoute.to, search: (prev) => ({ ...prev, runId: id, evidenceId: undefined }) })

  const openEvidence = (id: string) =>
    navigate({ to: currentPath, from: rootRoute.to, search: (prev) => ({ ...prev, evidenceId: id, runId: undefined }) })

  const closeDrawer = () =>
    navigate({ to: currentPath, from: rootRoute.to, search: (prev) => ({ ...prev, runId: undefined, evidenceId: undefined }) })

  return { runId, evidenceId, openRun, openEvidence, closeDrawer }
}
