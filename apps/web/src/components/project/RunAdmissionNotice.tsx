import { useId, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { getApiV1ProjectsByNameRunPreviewOptions, getApiV1ProjectsByNameRunAdmissionOptions, getApiV1SettingsOptions } from '@canonry/canonry-api-client/react-query'
import { providerConnectionName, formatModelName, openRouterRouteModel, ProviderErrorCodes, type ProviderAccountStreak, type ProviderErrorCode, type RunAdmissionDto, type RunPreviewDto } from '@canonry/canonry-contracts'
import { heyClient } from '../../api.js'
import { formatSweepInstant } from '../../lib/format-helpers.js'
import { catalogRouteFamilies } from '../../lib/provider-routes.js'
import { providerDisplayName } from '../../lib/visibility-trend-helpers.js'
import { RUNS_STALE_MS } from '../../queries/query-client.js'
import { Button } from '../ui/button.js'

/**
 * `GET /projects/:name/run-admission`: whether the next sweep would be refused,
 * and which providers it would leave out, for the selected sweep roster.
 */
export function useRunAdmission(projectName: string, enabled: boolean, selection: 'manual' | 'scheduled') {
  return useQuery({
    ...getApiV1ProjectsByNameRunAdmissionOptions({ client: heyClient, path: { name: projectName }, query: { selection } }),
    enabled: enabled && Boolean(projectName),
    staleTime: RUNS_STALE_MS,
    // A key saved from the CLI or in another tab lifts the hold.
    refetchOnWindowFocus: 'always',
    // Retry deadlines can lift holds while the operator stays on this page.
    // Refresh only admission; saved sweep results keep their own lifetime.
    refetchInterval: query => {
      const retries = Object.values(query.state.data?.providers ?? {})
        .map(hold => Date.parse(hold.retryAfter)).filter(Number.isFinite)
      if (retries.length === 0) return false
      const remaining = Math.min(...retries) - Date.now()
      return remaining > 0 ? remaining : RUNS_STALE_MS
    },
    retry: false,
  })
}

/** A provider named in a sentence: "OpenAI" / "OpenAI's", or "It" / "Its". */
interface Subject { name: string; possessive: string }

/** How an account failure reads in a sentence about one provider, and in a list. */
function accountFailure(code: ProviderErrorCode): { sentence: (subject: Subject) => string; label: string } {
  switch (code) {
    case ProviderErrorCodes.PROVIDER_BILLING:
      return { sentence: subject => `${subject.name} ran out of credit`, label: 'out of credit' }
    case ProviderErrorCodes.PROVIDER_AUTH:
      return { sentence: subject => `${subject.possessive} key was rejected or access was denied`, label: 'key rejected or access denied' }
    // Never held back for these; named as the API names them.
    case ProviderErrorCodes.RATE_LIMITED:
    case ProviderErrorCodes.PROVIDER_UNAVAILABLE:
    case ProviderErrorCodes.NETWORK:
    case ProviderErrorCodes.TIMEOUT:
    case ProviderErrorCodes.PARSE_ERROR:
    case ProviderErrorCodes.UNKNOWN:
      return { sentence: subject => `${subject.name} failed with ${code}`, label: code }
  }
}

function When({ iso }: { iso: string }) {
  return <time dateTime={iso}>{formatSweepInstant(iso)}</time>
}

/**
 * The next sweep's admission as the API reports it: refused because every
 * provider keeps failing on its account, or leaving some providers out. A
 * refused scheduled sweep leaves no run behind, so without this the project
 * would only look stalled. Renders nothing while every provider is called.
 *
 * The only fix inside Canonry is a new key, model or endpoint, so the settings
 * action appears only when a held provider's key was rejected; credit is added
 * in the provider's own console.
 */
export function RunAdmissionNoticeView({ admission, canFix, selection }: { admission: RunAdmissionDto; canFix: boolean; selection?: 'manual' | 'scheduled' }) {
  const headingId = useId()
  const held = Object.entries(admission.providers)
  // Holds are keyed by the route a sweep calls. The server's catalog names
  // every route family and display name (answer services included), so the
  // settings action reaches the connection that owns the key. Instance
  // settings are an administrator read, needed only for that action.
  const settings = useQuery({
    ...getApiV1SettingsOptions({ client: heyClient }),
    enabled: canFix && held.length > 0,
    retry: false,
  })
  const catalog = settings.data?.providerCatalog ?? []
  const families = catalogRouteFamilies(catalog)
  const displayName = (provider: string) => providerDisplayName(provider, catalog)
  if (held.length === 0) return null
  const [firstProvider, first] = held[0]!
  const firstName = displayName(firstProvider)
  const single = held.length === 1
  const runs = first.consecutiveRuns
  const keyFixable = held.find(([, streak]) => streak.code === ProviderErrorCodes.PROVIDER_AUTH)

  const checks = selection ? `${selection} checks` : 'checks'
  const title = admission.refused
    ? `${selection ? selection === 'manual' ? 'Manual checks' : 'Scheduled checks' : 'Checks'} are on hold`
    : single
      ? `${firstName} is left out of ${checks}`
      : `${held.length} providers are left out of ${checks}`

  let summary: ReactNode
  if (single) {
    // The title already names it when it is the one left out.
    const failure = accountFailure(first.code).sentence(admission.refused
      ? { name: firstName, possessive: `${firstName}'s` }
      : { name: 'It', possessive: 'Its' })
    const until = admission.refused ? admission.retryAfter ?? first.retryAfter : first.retryAfter
    const recovery = first.code === ProviderErrorCodes.PROVIDER_BILLING
      ? <>; add credit in {firstName}&apos;s console before then.</>
      : <>, or as soon as its key, model or endpoint is saved.</>
    summary = admission.refused
      ? <>{failure} in each of its last {runs} runs, so a check would fail the same way. The hold lifts <When iso={until} />{recovery}</>
      : <>{failure} in each of its last {runs} runs. Checks run without it until <When iso={until} />{recovery}</>
  } else {
    summary = admission.refused
      ? <>Every provider failed on its account in each of its last {runs} runs, so a check would fail the same way. The hold lifts{' '}
        {admission.retryAfter ? <When iso={admission.retryAfter} /> : 'at the first time below'}, or as soon as a provider&apos;s key, model or endpoint is saved.</>
      : <>Each failed on its account in each of its last {runs} runs. Checks run without them until the times below, or until a key, model or endpoint is saved.</>
  }

  return (
    <section
      aria-labelledby={headingId}
      className={`mb-5 flex flex-wrap items-start justify-between gap-3 rounded-md border px-4 py-3 text-label-14 ${
        admission.refused ? 'border-negative bg-negative-soft' : 'border-caution bg-caution-soft'
      }`}
    >
      {/* About 74 characters a line at 14px. */}
      <div className="min-w-0 max-w-[29rem] space-y-1">
        <h2 id={headingId} className={`text-heading-14 ${admission.refused ? 'text-negative' : 'text-caution'}`}>{title}</h2>
        <p className="text-secondary">{summary}</p>
        {single ? null : (
          <ul className="text-secondary">
            {held.map(([provider, streak]: [string, ProviderAccountStreak]) => (
              <li key={provider}>
                {displayName(provider)}: {accountFailure(streak.code).label}, until <When iso={streak.retryAfter} />
              </li>
            ))}
          </ul>
        )}
        {canFix ? null : <p className="text-secondary">Ask an administrator to fix {single ? firstName : 'these providers'}.</p>}
      </div>
      {canFix && keyFixable ? (
        <Button asChild variant="outline" size="sm" className="h-11 md:h-8">
          <Link to="/settings" hash={`provider-${providerConnectionName(keyFixable[0], families)}`}>
            {single ? `Update ${displayName(providerConnectionName(firstProvider, families))} key` : 'Open provider settings'}
          </Link>
        </Button>
      ) : null}
    </section>
  )
}


export function useRunPreview(projectName: string | null, enabled: boolean) {
  return useQuery({
    ...getApiV1ProjectsByNameRunPreviewOptions({ client: heyClient, path: { name: projectName ?? '' } }),
    enabled: enabled && Boolean(projectName), staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: 'always', retry: false,
  })
}

const RUN_PREVIEW_BLOCKED_COPY = {
  'unpublished-plan': 'Review and publish your measurement plan before running it.',
  'no-queries': 'Add at least one query before starting a check.',
  'no-provider': 'Connect an engine selected for this project.',
  'providers-failing': 'Repair a provider connection before retrying.',
  'run-in-progress': 'A check is already running for this project.',
} as const

export function RunPreviewSummary({ preview, pending, failed, onRetry }: {
  preview?: RunPreviewDto; pending: boolean; failed: boolean; onRetry: () => void
}) {
  if (failed) return <div role="alert" className="space-y-2 text-copy-14 text-negative"><p>Could not load the check details.</p><Button type="button" variant="outline" size="sm" onClick={onRetry}>Refresh check details</Button></div>
  if (!preview) return <p role="status" className="text-copy-14 text-secondary">Loading check details…</p>
  return <section aria-label="Check details" aria-busy={pending} className="space-y-4">
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 text-copy-14 text-secondary">
      <p><strong className="text-heading">{preview.queryCount}</strong> {preview.queryCount === 1 ? 'query' : 'queries'}</p>
      {preview.assignmentCount !== null && <p><strong className="text-heading">{preview.assignmentCount}</strong> Property assignments</p>}
      <p><strong className="text-heading">{preview.requestCount}</strong> provider {preview.requestCount === 1 ? 'request' : 'requests'}</p>
    </div>
    <p className="text-label-12 text-muted">{preview.queryClasses.filter(item => item.queryCount > 0).map(item => `${item.queryCount} ${item.queryClass === 'unknown' ? 'unclassified' : item.queryClass} ${item.queryCount === 1 ? 'query' : 'queries'}`).join(' · ')}</p>
    {preview.revision !== null && <p className="text-copy-14 text-secondary">Published plan · revision {preview.revision}. Unpublished changes are not included.</p>}
    {preview.engines.length > 0 && <div className="overflow-x-auto"><table className="evidence-table"><thead><tr><th>Engine</th><th className="text-right">Requests</th></tr></thead><tbody>{preview.engines.map(engine => {
      const hold = preview.admission.providers[engine.provider]
      const models = engine.models.filter(model => model !== openRouterRouteModel(engine.provider)).map(model => openRouterRouteModel(engine.provider) ? formatModelName(model) : model)
      return <tr key={engine.provider}><td>{providerDisplayName(engine.provider)}{(models.length > 0 || !openRouterRouteModel(engine.provider)) && <span className="block break-words text-copy-13 text-secondary">{models.join(', ') || 'Default model'}</span>}{hold ? <span className="block text-copy-13 text-caution">Skipped: {accountFailure(hold.code).label}. On hold until <When iso={hold.retryAfter} />.</span> : !engine.available && <span className="block text-copy-13 text-caution">Not available</span>}</td><td className="text-right tabular-nums">{engine.requestCount}</td></tr>
    })}</tbody></table></div>}
    {preview.locations.length > 0 && <p className="text-copy-14 text-secondary">Location: {preview.locations.map(item => item.location ?? 'No location targeting').join(' · ')}</p>}
    {preview.requestCount !== preview.expectedRequestCount && <p className="text-copy-14 text-caution">{preview.requestCount} of {preview.expectedRequestCount} planned requests can run.</p>}
    {preview.blockedReason && <p role="alert" className="text-copy-14 text-caution">{RUN_PREVIEW_BLOCKED_COPY[preview.blockedReason]}</p>}
    {preview.activeRunId && <Link to="/runs" search={{ runId: preview.activeRunId }} className="text-label-14 text-link underline">View running check</Link>}
  </section>
}
