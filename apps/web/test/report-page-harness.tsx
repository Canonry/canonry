/**
 * Renders the in-app report the way ProjectPage mounts it, from a report DTO,
 * with no network.
 *
 * The report query is seeded under the exact key the page requests and never
 * goes stale (`staleTime: Infinity`), so the page cannot refetch, fail, and
 * fall into its error branch. Only QueryClientProvider is needed: the account
 * context has a full-access default.
 *
 * vi.mock is hoisted per file, so a test that renders charts declares the
 * recharts stub itself:
 *   vi.mock('recharts', () => import('./report-recharts-stub.js'))
 * To assert the download, mock only that function and keep the rest of the
 * real module (isEmbed is a function that reads window config, never a flag):
 *   vi.mock('../src/api.js', async importOriginal => ({
 *     ...await importOriginal<typeof import('../src/api.js')>(),
 *     downloadReportHtml: vi.fn(async () => undefined),
 *   }))
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { getApiV1ProjectsByNameReportQueryKey } from '@ainyc/canonry-api-client/react-query'
import {
  REPORT_DEFAULT_PERIOD_DAYS,
  type ProjectReportDto,
  type ReportAudience,
  type ReportSectionId,
} from '@ainyc/canonry-contracts'
import { heyClient } from '../src/api.js'
import { REPORT_AUDIENCE_LABELS, REPORT_AUDIENCE_TOGGLE_LABEL, ReportPage } from '../src/pages/ReportPage.js'

export interface RenderReportPageOptions {
  /** Defaults to the report's project name. */
  projectName?: string
  /** Switch to this audience after the first render. The page opens on client. */
  audience?: ReportAudience
  /** Render as a read-only embed (window.__CANONRY_CONFIG__.embed). */
  embed?: boolean
}

export function renderReportPage(report: ProjectReportDto, options: RenderReportPageOptions = {}) {
  if (options.embed) window.__CANONRY_CONFIG__ = { ...window.__CANONRY_CONFIG__, embed: { enabled: true } }
  const projectName = options.projectName ?? report.meta.project.name
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(
    getApiV1ProjectsByNameReportQueryKey({ client: heyClient, path: { name: projectName }, query: { period: REPORT_DEFAULT_PERIOD_DAYS } }),
    report,
  )
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ReportPage projectName={projectName} />
    </QueryClientProvider>,
  )
  if (options.audience && options.audience !== 'client') selectReportAudience(options.audience)
  return { ...view, queryClient }
}

/** Press the Client or Agency option of the audience toggle. */
export function selectReportAudience(audience: ReportAudience): void {
  const toggle = screen.getByRole('group', { name: REPORT_AUDIENCE_TOGGLE_LABEL })
  fireEvent.click(within(toggle).getByRole('button', { name: REPORT_AUDIENCE_LABELS[audience] }))
}

/** The rendered report section with this id, or null when the page does not show it. */
export function queryReportSection(id: ReportSectionId, root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-report-section="${id}"]`)
}

/** The rendered report section with this id; throws when the page does not show it. */
export function getReportSection(id: ReportSectionId, root: ParentNode = document): HTMLElement {
  const section = queryReportSection(id, root)
  if (!section) throw new Error(`Report section "${id}" is not rendered`)
  return section
}

/** Unmount and clear the embed config. Call from afterEach. */
export function cleanupReportPage(): void {
  cleanup()
  delete window.__CANONRY_CONFIG__
}
