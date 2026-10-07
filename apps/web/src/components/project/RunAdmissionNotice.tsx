import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { getApiV1ProjectsByNameRunAdmissionOptions } from '@ainyc/canonry-api-client/react-query'
import { ProviderErrorCodes, type ProviderErrorCode, type RunAdmissionDto } from '@ainyc/canonry-contracts'
import { heyClient } from '../../api.js'
import { formatSweepInstant } from '../../lib/format-helpers.js'
import { providerDisplayName } from '../../lib/visibility-trend-helpers.js'
import { RUNS_STALE_MS } from '../../queries/query-client.js'
import { Button } from '../ui/button.js'

/** What an account failure means to the person who has to fix it. */
function accountFailureLabel(code: ProviderErrorCode): string {
  switch (code) {
    case ProviderErrorCodes.PROVIDER_AUTH: return 'key rejected or access denied'
    case ProviderErrorCodes.PROVIDER_BILLING: return 'out of credit'
    // Never held back for these; shown as the API names them.
    case ProviderErrorCodes.RATE_LIMITED:
    case ProviderErrorCodes.PROVIDER_UNAVAILABLE:
    case ProviderErrorCodes.NETWORK:
    case ProviderErrorCodes.TIMEOUT:
    case ProviderErrorCodes.PARSE_ERROR:
    case ProviderErrorCodes.UNKNOWN:
      return code
  }
}

/**
 * The next sweep's admission as the API reports it: refused because every
 * provider keeps failing on its account, or leaving some providers out. A
 * refused scheduled sweep leaves no run behind, so without this the project
 * would only look stalled. Renders nothing while every provider is called.
 */
export function RunAdmissionNoticeView({ admission, canFix }: { admission: RunAdmissionDto; canFix: boolean }) {
  const held = Object.entries(admission.providers)
  if (held.length === 0) return null
  const streak = held[0]![1].consecutiveRuns
  const title = admission.refused
    ? 'Sweeps are on hold'
    : held.length === 1
      ? `${providerDisplayName(held[0]![0])} is left out of sweeps`
      : `${held.length} providers are left out of sweeps`
  const summary = admission.refused
    ? `Every provider failed on its account in each of its last ${streak} runs, so a new sweep would fail the same way. `
      + `${admission.retryAfter ? `One sweep runs after ${formatSweepInstant(admission.retryAfter)}, or` : 'One runs'} `
      + 'as soon as a provider\'s key, model or endpoint is saved.'
    : `${held.length === 1 ? 'It' : 'Each'} failed on its account in each of its last ${streak} runs. `
      + `Sweeps call the other providers and try ${held.length === 1 ? 'it' : 'each'} again after the time below, `
      + 'or as soon as its key, model or endpoint is saved.'
  return (
    <div
      role="status"
      className={`mb-5 flex flex-wrap items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
        admission.refused ? 'border-negative bg-negative-soft' : 'border-caution bg-caution-soft'
      }`}
    >
      <div className="min-w-0 max-w-prose space-y-1">
        <p className={`font-medium ${admission.refused ? 'text-negative' : 'text-caution'}`}>{title}</p>
        <p className="text-secondary">{summary}</p>
        <ul className="text-secondary">
          {held.map(([provider, hold]) => (
            <li key={provider}>
              {providerDisplayName(provider)}: {accountFailureLabel(hold.code)}. Tried again after{' '}
              <time dateTime={hold.retryAfter}>{formatSweepInstant(hold.retryAfter)}</time>.
            </li>
          ))}
        </ul>
      </div>
      {canFix ? (
        <Button asChild variant="outline" size="sm">
          <Link to="/settings">Open provider settings</Link>
        </Button>
      ) : null}
    </div>
  )
}

/** Reads `GET /projects/:name/run-admission` and shows `RunAdmissionNoticeView`. */
export function RunAdmissionNotice({ projectName, canFix }: { projectName: string; canFix: boolean }) {
  const query = useQuery({
    ...getApiV1ProjectsByNameRunAdmissionOptions({ client: heyClient, path: { name: projectName } }),
    enabled: Boolean(projectName),
    staleTime: RUNS_STALE_MS,
    // A key saved from the CLI or in another tab lifts the hold.
    refetchOnWindowFocus: 'always',
    retry: false,
  })
  // A notice, not the page: a failed read shows nothing rather than an error.
  if (!query.data) return null
  return <RunAdmissionNoticeView admission={query.data} canFix={canFix} />
}
