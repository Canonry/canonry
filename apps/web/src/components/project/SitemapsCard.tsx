import { useState, type ReactNode } from 'react'
import type { EngineSitemapDto, EngineSitemapsDto, SitemapSource } from '@canonry/canonry-contracts'
import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { DataTablePagination, DataTableSearch, useClientTable } from '../shared/DataTableControls.js'
import { formatTimestamp } from '../../lib/format-helpers.js'
import { SitemapRowAction, SitemapTable, type SitemapRowView } from './SitemapTable.js'

type Engine = 'Google' | 'Bing'

const PAGE_SIZE = 10

const TONE: Record<EngineSitemapDto['state'], SitemapRowView['status']['tone']> = {
  ok: 'positive',
  pending: 'neutral',
  warnings: 'caution',
  errors: 'negative',
  other: 'neutral',
}

const SOURCE_PLACES: Record<SitemapSource, string> = { site: 'on your site', google: 'in Google', bing: 'in Bing' }

/** Where a missing sitemap was seen, in words: "on your site and in Google". */
export function missingFoundIn(foundIn: readonly SitemapSource[]): string {
  return foundIn.map((source) => SOURCE_PLACES[source]).join(' and ')
}

function issueText(row: EngineSitemapDto): string | undefined {
  const parts = [
    row.errors ? `${row.errors} error${row.errors === 1 ? '' : 's'}` : '',
    row.warnings ? `${row.warnings} warning${row.warnings === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export interface SitemapsCardProps {
  engine: Engine
  /** The stored list, null when it was never read, undefined while it loads. */
  data: EngineSitemapsDto | null | undefined
  loadError?: string | null
  /** The URL as the list shows it (path on the site, full URL in the title). */
  label: (url: string) => string
  /** Whether this viewer and connection can submit. */
  canSubmit: boolean
  /** Shown in place of Add another when submitting is not allowed (a read-only grant). */
  submitBlocked?: ReactNode
  /**
   * Submit (or resubmit) the given sitemaps and resolve with the ones the
   * engine accepted. Only those read "Sent"; a failure stays "Missing".
   */
  onSubmit: (urls: string[]) => Promise<readonly string[]>
  submitting: boolean
  /** Canonry's default sitemap for this engine, if it has one. */
  defaultUrl?: string | null
  onSetDefault?: (url: string) => void
  settingDefault?: boolean
  onInspect?: (url: string) => void
  inspecting?: boolean
  /** Extra controls beside the filter, such as Google's Resubmit all menu. */
  bulk?: ReactNode
  /** What to show while the list has never been read. */
  notRead: ReactNode
  /** Embeds show the list with no actions. */
  readOnly?: boolean
}

/**
 * One engine's sitemaps: what it lists, and above them what it is missing
 * (sitemaps the site declares or someone submitted to the other engine), each with a one-click
 * add. Typing a URL is the rare case, behind Add another.
 */
export function SitemapsCard(props: SitemapsCardProps) {
  const { engine, data, label } = props
  const [formOpen, setFormOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set())
  const [search, setSearch] = useState('')

  const listed = data?.sitemaps ?? []
  const toView = (row: EngineSitemapDto): SitemapRowView => ({
    url: row.url,
    label: label(row.url),
    isIndex: row.isIndex,
    kind: !row.isIndex && row.type && !/^sitemap$/i.test(row.type) ? row.type : undefined,
    status: { label: row.statusLabel, tone: TONE[row.state], detail: issueText(row) },
    urls: row.urlCount,
    submittedAt: row.submittedAt,
    lastReadAt: row.lastReadAt,
    isDefault: props.defaultUrl === row.url,
  })
  const missingRows: SitemapRowView[] = (data?.missing ?? []).map((row) => ({
    url: row.url,
    label: label(row.url),
    isIndex: false,
    status: sent.has(row.url)
      ? { label: 'Sent', tone: 'neutral', detail: 'shows after the next sync' }
      : { label: 'Missing', tone: 'caution', detail: missingFoundIn(row.foundIn) },
    urls: null,
    submittedAt: null,
    lastReadAt: null,
    missing: true,
  }))
  const listedRows: SitemapRowView[] = listed
    .filter((row) => row.parentUrl === null)
    .map((row) => ({ ...toView(row), files: row.isIndex ? listed.filter((file) => file.parentUrl === row.url).map(toView) : undefined }))
  const table = useClientTable({
    rows: [...missingRows, ...listedRows],
    getSearchText: (row) => `${row.url} ${row.files?.map((file) => file.url).join(' ') ?? ''}`,
    pageSize: PAGE_SIZE,
  })

  async function submit(urls: string[]): Promise<readonly string[]> {
    const accepted = await props.onSubmit(urls)
    if (accepted.length > 0) setSent((current) => new Set([...current, ...accepted]))
    return accepted
  }

  const missingCount = missingRows.filter((row) => !sent.has(row.url)).length
  const indexes = listedRows.filter((row) => row.isIndex).length

  return (
    <Card className="surface-card">
      <div className="section-head section-head-inline">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex items-center gap-1.5">
            <h3>Sitemaps</h3>
            <InfoTooltip text={`Canonry compares the sitemaps your site lists (from the latest Site Health scan) with what ${engine} and the other engine have, and shows what ${engine} is missing. Submitting asks ${engine} to read a sitemap; it does not guarantee indexing.`} />
          </div>
          {missingCount > 0 && (
            <InfoTooltip
              tone="caution"
              label={`${missingCount} missing`}
              text={`${missingCount === 1 ? 'One sitemap your site or the other engine has is' : `${missingCount} sitemaps your site or the other engine has are`} not in ${engine}. Add ${missingCount === 1 ? 'it' : 'them'} from the list.`}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data && <span className="text-label-13 text-secondary">As of {formatTimestamp(data.syncedAt)}</span>}
          {!props.readOnly && (props.canSubmit ? (
            <Button type="button" variant="ghost" size="sm" disabled={formOpen || props.submitting} onClick={() => setFormOpen(true)}>
              Add another
            </Button>
          ) : props.submitBlocked)}
        </div>
      </div>

      {formOpen && props.canSubmit && !props.readOnly && (
        <form
          className="mb-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault()
            const next = url.trim()
            if (!next) return
            void submit([next]).then((accepted) => {
              // Keep the box open on a refusal so the URL can be fixed.
              if (!accepted.includes(next)) return
              setUrl('')
              setFormOpen(false)
            })
          }}
        >
          <input
            aria-label="Sitemap URL"
            className="flex-1 rounded border border-strong bg-transparent px-2 py-1.5 font-mono text-label-13 text-strong placeholder-mono-400 focus:border-mono-500 focus:outline-none"
            type="url"
            autoFocus
            placeholder="https://example.com/sitemap.xml"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={props.submitting || !url.trim()}>
              {props.submitting ? 'Submitting…' : `Submit to ${engine}`}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setFormOpen(false); setUrl('') }}>Cancel</Button>
          </div>
        </form>
      )}

      {props.loadError ? (
        <p className="text-copy-14 text-negative">Could not load sitemaps: {props.loadError}</p>
      ) : data === undefined ? (
        <p className="text-copy-14 text-secondary">Loading sitemaps…</p>
      ) : data === null ? (
        props.notRead
      ) : (
        <>
          {(listedRows.length > 0 || missingRows.length > 0) && (
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <DataTableSearch className="w-full sm:w-64" value={search} onChange={(value) => { setSearch(value); table.setQuery(value) }} label="Filter sitemaps" placeholder="Filter sitemaps…" />
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-label-13 text-secondary">
                  {listedRows.length} in {engine}{indexes > 0 ? `, ${indexes} ${indexes === 1 ? 'index' : 'indexes'}` : ''}
                </span>
                {props.bulk}
              </div>
            </div>
          )}
          <SitemapTable
            rows={table.rows}
            expanded={expanded}
            onToggle={(next) => setExpanded((current) => {
              const copy = new Set(current)
              if (copy.has(next)) copy.delete(next)
              else copy.add(next)
              return copy
            })}
            lastReadLabel="Last read"
            empty={`${engine} lists no sitemaps for this site, and Canonry found none to add.`}
            actions={props.readOnly ? undefined : (row) => row.missing ? (
              <SitemapRowAction disabled={!props.canSubmit || props.submitting || sent.has(row.url)} onClick={() => void submit([row.url])}>
                {sent.has(row.url) ? 'Sent' : `Add to ${engine}`}
              </SitemapRowAction>
            ) : (
              <>
                <SitemapRowAction disabled={!props.canSubmit || props.submitting} onClick={() => void submit([row.url])}>
                  {row.submittedAt ? 'Resubmit' : 'Submit'}
                </SitemapRowAction>
                {props.onInspect && (
                  <SitemapRowAction disabled={props.inspecting} onClick={() => props.onInspect!(row.url)}>Inspect URLs</SitemapRowAction>
                )}
                {props.onSetDefault && !row.isDefault && (
                  <SitemapRowAction disabled={props.settingDefault} title="Canonry uses this sitemap when a command names none." onClick={() => props.onSetDefault!(row.url)}>
                    Set as default
                  </SitemapRowAction>
                )}
              </>
            )}
          />
          {table.totalRows > PAGE_SIZE && (
            <DataTablePagination page={table.page} pageSize={PAGE_SIZE} visibleRows={table.rows.length} totalRows={table.totalRows} onPageChange={table.setPage} itemLabel="sitemaps" />
          )}
        </>
      )}
    </Card>
  )
}
