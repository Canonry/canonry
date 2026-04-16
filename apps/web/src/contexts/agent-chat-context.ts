import { createContext, useContext } from 'react'

interface AgentChatActions {
  askAero: (message: string, context?: { page?: string; projectName?: string; insightId?: string }) => void
  isConfigured: boolean
}

export const AgentChatContext = createContext<AgentChatActions>({
  askAero: () => {},
  isConfigured: false,
})

export function useAskAero() {
  return useContext(AgentChatContext)
}
