import { Fragment, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { MiddleTruncatedText } from '../shared/DataTableControls.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { formatChartDateLabel } from '../shared/ChartPrimitives.js'

/**
 * One sitemap as both search engine tabs show it. Google's and Bing's lists
 * share this table so the two read the same way: the path, one status, the URL
 * count, when it was submitted and last read, and its actions on hover.
 */
export interface SitemapRowView {
  url: string
  /** The path on the site, shown in place of the full URL. */
  label: string
  isIndex: boolean
  /** A feed type other than a sitemap (RSS, Atom), shown beside the path. */
  kind?: string
  status: { label: string; tone: 'positive' | 'caution' | 'negative' | 'neutral'; detail?: string }
  urls: number | null
  submittedAt: string | null
  lastReadAt: string | null
  /** Canonry's default sitemap for this engine. */
  isDefault?: boolean
  /** The files an index lists; undefined until they are loaded. */
  files?: readonly SitemapRowView[]
}

export const SITEMAP_DEFAULT_HELP = 'Canonry uses this sitemap when a command names none.'

function day(value: string | null): string {
  return value ? formatChartDateLabel(value.slice(0, 10)) : '—'
}

/** A quiet text action inside a row. */
export function SitemapRowAction({ children, onClick, disabled, title }: { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded px-1.5 py-0.5 text-button-14 text-secondary hover:bg-surface-hover hover:text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  )
}

export function SitemapTable({ rows, expanded, loading, onToggle, actions, lastReadLabel, empty }: {
  rows: readonly SitemapRowView[]
  /** Index URLs whose files are open. */
  expanded: ReadonlySet<string>
  /** Index URLs whose files are loading. */
  loading?: ReadonlySet<string>
  onToggle: (url: string) => void
  /** The row's actions, shown on hover or focus (always on touch screens). Omit for none. */
  actions?: (row: SitemapRowView, parent: SitemapRowView | null) => ReactNode
  lastReadLabel: string
  empty: ReactNode
}) {
  const columns = actions ? 6 : 5
  const renderRow = (row: SitemapRowView, parent: SitemapRowView | null) => {
    const open = expanded.has(row.url)
    const busy = loading?.has(row.url) ?? false
    return (
      <tr key={`${parent?.url ?? ''}|${row.url}`} className="group">
        <td className={`max-w-md ${parent ? 'pl-9' : ''}`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {row.isIndex && !parent && (
              <button
                type="button"
                aria-expanded={open}
                aria-label={`${open ? 'Hide' : 'Show'} the sitemaps in ${row.label}`}
                className="rounded p-0.5 text-secondary hover:text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
                onClick={() => onToggle(row.url)}
              >
                {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
              </button>
            )}
            <MiddleTruncatedText value={row.label} title={row.url} className="font-mono text-label-13 text-neutral" />
            {row.isIndex && (
              <span className="shrink-0 text-label-12 text-secondary">
                {busy ? 'Loading…' : row.files ? `Index · ${row.files.length} ${row.files.length === 1 ? 'sitemap' : 'sitemaps'}` : 'Index'}
              </span>
            )}
            {row.kind && <span className="shrink-0 text-label-12 text-secondary">{row.kind}</span>}
            {row.isDefault && (
              <span className="flex shrink-0 items-center gap-1 text-label-12 text-secondary">
                Default
                <InfoTooltip text={SITEMAP_DEFAULT_HELP} />
              </span>
            )}
          </div>
        </td>
        <td>
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <ToneBadge tone={row.status.tone}>{row.status.label}</ToneBadge>
            {row.status.detail && <span className="text-label-12 text-secondary">{row.status.detail}</span>}
          </div>
        </td>
        <td className="text-right tabular-nums text-secondary">{row.urls === null ? '—' : row.urls.toLocaleString()}</td>
        <td className="whitespace-nowrap tabular-nums text-secondary">{day(row.submittedAt)}</td>
        <td className="whitespace-nowrap tabular-nums text-secondary">{row.lastReadAt ? day(row.lastReadAt) : 'Not yet'}</td>
        {actions && (
          <td className="text-right">
            <div className="flex justify-end gap-0.5 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
              {actions(row, parent)}
            </div>
          </td>
        )}
      </tr>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="data-table w-full text-label-14">
        <thead>
          <tr>
            <th className="text-left">Sitemap</th>
            <th className="text-left">Status</th>
            <th className="text-right">URLs</th>
            <th className="text-left">Submitted</th>
            <th className="text-left">{lastReadLabel}</th>
            {actions && <th className="text-right"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={columns} className="py-6 text-center text-secondary">{empty}</td></tr>
          )}
          {rows.map((row) => (
            <Fragment key={row.url}>
              {renderRow(row, null)}
              {row.isIndex && expanded.has(row.url) && (row.files ?? []).map((file) => renderRow(file, row))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}
