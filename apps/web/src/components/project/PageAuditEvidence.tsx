import type {
  SiteAuditFactorStatus,
  SiteCrawlPageAuditDto,
} from '@ainyc/canonry-contracts'
import { ChevronRight } from 'lucide-react'

import type { MetricTone } from '../../view-models.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { Button } from '../ui/button.js'

function scoreTone(score: number): MetricTone {
  if (score >= 70) return 'positive'
  if (score >= 40) return 'caution'
  return 'negative'
}

function scoreStatus(score: number): SiteAuditFactorStatus {
  if (score >= 70) return 'pass'
  if (score >= 40) return 'partial'
  return 'fail'
}

function factorTone(status: SiteAuditFactorStatus): MetricTone {
  if (status === 'pass') return 'positive'
  if (status === 'partial') return 'caution'
  return 'negative'
}

function stateLabel(status: SiteAuditFactorStatus): string {
  if (status === 'pass') return 'Pass'
  if (status === 'partial') return 'Partial'
  return 'Fail'
}

export function PageAuditEvidence({
  audit,
  isLoading,
  error,
  onRetry,
}: {
  audit: SiteCrawlPageAuditDto | undefined
  isLoading: boolean
  error: Error | null
  onRetry: () => void
}) {
  return (
    <section className="border-t border-default pt-5" aria-labelledby="site-health-page-audit-heading">
      <div>
        {/* "Findings and fixes" sits directly under the SITE score and repeats
            the same check names against one page, with different numbers. Say
            whose numbers these are, or the two lists read as a contradiction. */}
        <h3 id="site-health-page-audit-heading" className="text-base font-semibold text-heading">
          Findings and fixes for this page
        </h3>
      </div>

      {isLoading ? (
        <p className="mt-4 text-sm text-secondary" role="status">Loading findings...</p>
      ) : error ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-y border-negative bg-negative-soft px-4 py-3" role="alert">
          <p className="text-sm text-negative">Findings could not be loaded.</p>
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>Try again</Button>
        </div>
      ) : !audit ? (
        <p className="mt-4 text-sm text-secondary">No findings are available for this page.</p>
      ) : audit.state === 'no-crawl' ? (
        <p className="mt-4 text-sm text-secondary">No Site Health scan is available.</p>
      ) : audit.state === 'details-unavailable' ? (
        <p className="mt-4 text-sm text-secondary">This scan saved its summary, but not the findings for each page.</p>
      ) : audit.state === 'not-found' ? (
        <p className="mt-4 text-sm text-secondary">This page is not present in the selected scan.</p>
      ) : audit.state === 'not-audited' ? (
        <p className="mt-4 text-sm text-secondary">This page was found, but it was not scored.</p>
      ) : (
        <ReadyPageAudit audit={audit} />
      )}
    </section>
  )
}

function ReadyPageAudit({ audit }: {
  audit: Extract<SiteCrawlPageAuditDto, { state: 'ready' }>
}) {
  const actionableFactors = audit.factors.filter((factor) => (
    factor.applicable !== false
    && (factor.status !== 'pass' || factor.findings.some((finding) => (
      finding.type === 'missing' || finding.type === 'timeout' || finding.type === 'unreachable'
    )))
  ))

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          aria-label={`Score ${Math.round(audit.auditScore)} out of 100`}
          className="text-2xl font-semibold tabular-nums text-heading"
        >
          {Math.round(audit.auditScore)}<span className="text-sm text-muted">/100</span>
        </span>
        <ToneBadge tone={scoreTone(audit.auditScore)}>{stateLabel(scoreStatus(audit.auditScore))}</ToneBadge>
      </div>

      {audit.evidenceState === 'scores-only' && (
        <p className="mt-3 border border-caution bg-caution-soft px-3 py-2 text-sm text-caution">
          This older scan saved only the scores, not the findings or fixes.
        </p>
      )}

      {audit.criticalDefects.length > 0 && (
        <section className="mt-5" aria-labelledby="site-health-critical-defects-heading">
          <div className="flex flex-wrap items-center gap-2">
            <h4 id="site-health-critical-defects-heading" className="text-sm font-semibold text-heading">Problems outside the score</h4>
            <ToneBadge tone={audit.criticalDefects.some((defect) => defect.severity === 'critical') ? 'negative' : 'caution'}>
              {audit.criticalDefects.length}
            </ToneBadge>
            <span className="text-xs text-muted">Not counted in the score</span>
          </div>
          <ul className="mt-2 divide-y divide-default border-y border-default">
            {audit.criticalDefects.map((defect) => (
              <li key={defect.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-heading">{defect.detail}</p>
                  <ToneBadge tone={defect.severity === 'critical' ? 'negative' : 'caution'}>
                    {defect.severity === 'critical' ? 'Critical' : 'Warning'}
                  </ToneBadge>
                </div>
                <p className="mt-1 text-sm text-secondary"><span className="font-medium text-heading">Fix:</span> {defect.recommendation}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {actionableFactors.length > 0 ? (
        <div className="mt-5 divide-y divide-default border-y border-default">
          {/*
            Every check starts CLOSED so the page opens scannable: the summary
            row below carries the factor name, its score, and its pass/partial/
            fail badge, which is everything a reader needs to decide what to
            open. Critical defects are NOT in here: they render above in their
            own always-visible section, so collapsing these hides nothing that
            demands attention.

            Native <details> is the disclosure primitive this file already used,
            so the toggle stays a real button with browser-managed expanded
            state and the closed content is genuinely out of the tab order.
          */}
          {actionableFactors.map((factor) => (
            <details key={factor.id} className="group py-1">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-sm px-1 py-2 outline-none marker:hidden focus-visible:ring-2 focus-visible:ring-mono-400 [&::-webkit-details-marker]:hidden">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-heading">
                  <ChevronRight className="size-4 shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden="true" />
                  {factor.name}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-sm tabular-nums text-heading">{Math.round(factor.score)}/100</span>
                  <ToneBadge tone={factorTone(factor.status)}>{stateLabel(factor.status)}</ToneBadge>
                </span>
              </summary>
              <div className="grid gap-4 px-1 pb-4 pt-1 md:grid-cols-2">
                <div>
                  <h5 className="text-xs font-semibold uppercase tracking-wide text-muted">Evidence</h5>
                  {factor.findings.length > 0 ? (
                    <ul className="mt-2 space-y-1.5 text-sm text-secondary">
                      {factor.findings.map((finding, findingIndex) => (
                        <li key={`${finding.code}:${findingIndex}`}>{finding.message}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-secondary">
                      {audit.evidenceState === 'scores-only'
                        ? 'This scan did not save the findings here.'
                        : 'Nothing to report here.'}
                    </p>
                  )}
                </div>
                <div>
                  <h5 className="text-xs font-semibold uppercase tracking-wide text-muted">Recommended fix</h5>
                  {factor.recommendations.length > 0 ? (
                    <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-secondary marker:text-muted">
                      {factor.recommendations.map((recommendation) => <li key={recommendation}>{recommendation}</li>)}
                    </ol>
                  ) : (
                    <p className="mt-2 text-sm text-secondary">
                      {audit.evidenceState === 'scores-only'
                        ? 'This scan did not save a fix here.'
                        : 'No fix suggested here.'}
                    </p>
                  )}
                  <p className="mt-3 text-xs text-muted">Worth {factor.weight}% of the page score</p>
                </div>
              </div>
            </details>
          ))}
        </div>
      ) : audit.criticalDefects.length === 0 && audit.evidenceState === 'complete' ? (
        <p className="mt-4 border-y border-positive bg-positive-soft px-4 py-3 text-sm text-positive">
          Nothing needs attention on this page.
        </p>
      ) : audit.criticalDefects.length === 0 ? (
        <p className="mt-4 border-y border-default px-4 py-3 text-sm text-secondary">
          This scan saved only the score. Run a new scan to see findings.
        </p>
      ) : null}
    </div>
  )
}
