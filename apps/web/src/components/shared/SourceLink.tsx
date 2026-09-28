import { safeExternalUrl } from '../../lib/safe-url.js'

/** Show the recorded destination even when the provider supplies a title. */
export function SourceLink({ url, title }: { url: string; title?: string | null }) {
  const safeUrl = safeExternalUrl(url)
  const href = safeUrl && /^https?:\/\//i.test(safeUrl) ? safeUrl : null
  return (
    <span className="block min-w-0 text-sm [overflow-wrap:anywhere]">
      {title && title !== url ? <span className="block text-secondary">{title}</span> : null}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-link underline underline-offset-2 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400">
          {url}
        </a>
      ) : <span className="text-secondary">{url}</span>}
    </span>
  )
}
