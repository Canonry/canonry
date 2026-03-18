import { createContext, useContext } from 'react'
import type { DashboardVm, HealthSnapshot } from '../view-models.js'

interface DashboardContextValue {
  dashboard: DashboardVm
  health: HealthSnapshot
}

const DashboardContext = createContext<DashboardContextValue | null>(null)
export const DashboardProvider = DashboardContext.Provider
export function useInitialDashboard() { return useContext(DashboardContext) }
