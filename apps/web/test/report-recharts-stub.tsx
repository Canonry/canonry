/**
 * Recharts stand-in for report page tests.
 *
 * jsdom has no layout and no ResizeObserver, so a real ResponsiveContainer
 * renders nothing useful. Report charts are asserted through their
 * `role="img"` wrappers and accessible names instead. Every component
 * ChartPrimitives imports from recharts is exported here.
 *
 * vi.mock is hoisted per test file, so each report test declares:
 *   vi.mock('recharts', () => import('./report-recharts-stub.js'))
 */
import type { ReactNode } from 'react'

function Passthrough({ children }: { children?: ReactNode }) {
  return <div>{children}</div>
}

function Nothing() {
  return null
}

export const ResponsiveContainer = Passthrough
export const ComposedChart = Passthrough
export const BarChart = Passthrough
export const Area = Nothing
export const Bar = Nothing
export const CartesianGrid = Nothing
export const Cell = Nothing
export const LabelList = Nothing
export const Legend = Nothing
export const Line = Nothing
export const ReferenceArea = Nothing
export const ReferenceLine = Nothing
export const Tooltip = Nothing
export const XAxis = Nothing
export const YAxis = Nothing
