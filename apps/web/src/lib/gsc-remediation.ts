import type { ApiErrorInfo } from './extract-error-message.js'

export interface GscActionNeeded {
  title: string
  message: string
  /** Google Cloud "enable API" deep links, when the project number was parsed. */
  enableUrl?: string
  indexingApiUrl?: string
  projectNumber?: string
}

/**
 * When a Search Console call fails because the operator's own Google Cloud
 * project hasn't enabled the Search Console API, the backend returns FORBIDDEN
 * with `details.reason === 'gsc-api-disabled'` plus the enable deep links and
 * GCP project number. Turn that into a first-class "Action needed" card so the
 * setup flow can show a one-click remediation rather than a raw error string.
 *
 * Returns null for any other error (including the other GSC FORBIDDEN reasons,
 * `gsc-reconnect` / `gsc-no-property-access`, whose self-explanatory messages
 * render fine as a plain inline error) so the caller falls back to that path.
 */
export function gscActionNeededFromError(info: ApiErrorInfo): GscActionNeeded | null {
  const d = info.details
  if (info.code !== 'FORBIDDEN' || !d || d.reason !== 'gsc-api-disabled') return null
  const projectNumber = typeof d.projectNumber === 'string' ? d.projectNumber : undefined
  return {
    title: 'Enable the Search Console API',
    message:
      `Your Google Cloud project${projectNumber ? ` (${projectNumber})` : ''} hasn't enabled the Search Console API. `
      + 'Enable the Search Console API and the Indexing API, wait ~2–5 minutes, then retry.',
    enableUrl: typeof d.enableUrl === 'string' ? d.enableUrl : undefined,
    indexingApiUrl: typeof d.indexingApiUrl === 'string' ? d.indexingApiUrl : undefined,
    projectNumber,
  }
}
