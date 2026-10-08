import { useId, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { getApiV1ProjectsByNameRunAdmissionOptions } from '@ainyc/canonry-api-client/react-query'
import { ProviderErrorCodes, type ProviderAccountStreak, type ProviderErrorCode, type RunAdmissionDto } from '@ainyc/canonry-contracts'
import { heyClient } from '../../api.js'
import { formatSweepInstant } from '../../lib/format-helpers.js'
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
  if (held.length === 0) return null
  const [firstProvider, first] = held[0]!
  const firstName = providerDisplayName(firstProvider)
  const single = held.length === 1
  const runs = first.consecutiveRuns
  const keyFixable = held.find(([, streak]) => streak.code === ProviderErrorCodes.PROVIDER_AUTH)

  const sweeps = selection ? `${selection} sweeps` : 'sweeps'
  const title = admission.refused
    ? `${selection ? selection === 'manual' ? 'Manual sweeps' : 'Scheduled sweeps' : 'Sweeps'} are on hold`
    : single
      ? `${firstName} is left out of ${sweeps}`
      : `${held.length} providers are left out of ${sweeps}`

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
      ? <>{failure} in each of its last {runs} runs, so a sweep would fail the same way. The hold lifts <When iso={until} />{recovery}</>
      : <>{failure} in each of its last {runs} runs. Sweeps run without it until <When iso={until} />{recovery}</>
  } else {
    summary = admission.refused
      ? <>Every provider failed on its account in each of its last {runs} runs, so a sweep would fail the same way. The hold lifts{' '}
        {admission.retryAfter ? <When iso={admission.retryAfter} /> : 'at the first time below'}, or as soon as a provider&apos;s key, model or endpoint is saved.</>
      : <>Each failed on its account in each of its last {runs} runs. Sweeps run without them until the times below, or until a key, model or endpoint is saved.</>
  }

  return (
    <section
      aria-labelledby={headingId}
      className={`mb-5 flex flex-wrap items-start justify-between gap-3 rounded-md border px-4 py-3 text-sm ${
        admission.refused ? 'border-negative bg-negative-soft' : 'border-caution bg-caution-soft'
      }`}
    >
      {/* About 74 characters a line at 14px. */}
      <div className="min-w-0 max-w-[29rem] space-y-1">
        <h2 id={headingId} className={`text-sm font-medium ${admission.refused ? 'text-negative' : 'text-caution'}`}>{title}</h2>
        <p className="text-secondary">{summary}</p>
        {single ? null : (
          <ul className="text-secondary">
            {held.map(([provider, streak]: [string, ProviderAccountStreak]) => (
              <li key={provider}>
                {providerDisplayName(provider)}: {accountFailure(streak.code).label}, until <When iso={streak.retryAfter} />
              </li>
            ))}
          </ul>
        )}
        {canFix ? null : <p className="text-secondary">Ask an administrator to fix {single ? firstName : 'these providers'}.</p>}
      </div>
      {canFix && keyFixable ? (
        <Button asChild variant="outline" size="sm" className="h-11 md:h-8">
          <Link to="/settings" hash={`provider-${keyFixable[0]}`}>
            {single ? `Update ${firstName} key` : 'Open provider settings'}
          </Link>
        </Button>
      ) : null}
    </section>
  )
}
