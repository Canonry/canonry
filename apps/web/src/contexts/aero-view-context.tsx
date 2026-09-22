import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AgentViewContext } from '@ainyc/canonry-contracts'

interface PublishedView { project: string; context: AgentViewContext }
const AeroView = createContext<{ view: PublishedView | null; publish: (view: PublishedView) => () => void }>({ view: null, publish: () => () => {} })

export function AeroViewProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<PublishedView | null>(null)
  const publish = useCallback((next: PublishedView) => {
    setView(next)
    return () => setView(current => current === next ? null : current)
  }, [])
  return <AeroView.Provider value={useMemo(() => ({ view, publish }), [view, publish])}>{children}</AeroView.Provider>
}

/** Pages publish effective filters, rather than filters merely carried in the URL. */
export function usePublishAeroView(project: string, context: AgentViewContext) {
  const { publish } = useContext(AeroView)
  const serialized = JSON.stringify(context)
  useEffect(() => publish({ project, context: JSON.parse(serialized) as AgentViewContext }), [publish, project, serialized])
}

export function useAeroView(project: string, fallback: AgentViewContext): AgentViewContext {
  const { view } = useContext(AeroView)
  return view?.project === project && view.context.view === fallback.view ? view.context : fallback
}
