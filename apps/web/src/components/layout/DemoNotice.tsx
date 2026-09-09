import { getPublicBase, isPublicDemo } from '../../api.js'

const FEATURE_LINKS = [
  ['AI answers, citations, and competitors', '/projects/summit-roofing'],
  ['Properties, markets, and tracked queries', '/projects/harbor-resorts'],
  ['Search performance and indexing', '/projects/summit-roofing/search-console'],
  ['Site health and page map', '/projects/harbor-resorts/technical-aeo'],
  ['Traffic and conversion evidence', '/projects/summit-roofing/conversions'],
  ['Local presence', '/projects/summit-roofing/local'],
  ['Query assignments and research', '/projects/harbor-resorts/queries'],
  ['Backlinks', '/projects/summit-roofing/backlinks'],
  ['Reports', '/projects/harbor-resorts/report'],
  ['Run and change history', '/projects/harbor-resorts/activity'],
] as const

export function DemoNotice() {
  if (!isPublicDemo()) return null
  const base = getPublicBase()
  return (
    <aside className="demo-notice" aria-label="Public demo">
      <div className="demo-notice-intro">
        <strong>Explore Canonry</strong>
        <span>View-only demo with fictional sample data.</span>
        <nav aria-label="Demo examples">
          <a href={`${base}/projects/summit-roofing`}>Standard business</a>
          <a href={`${base}/projects/harbor-resorts`}>Property portfolio</a>
        </nav>
      </div>
      <details>
        <summary>Explore features</summary>
        <p>Open a report, change its filters, and follow the evidence. Connections, edits, and live runs are disabled.</p>
        <ul>
          {FEATURE_LINKS.map(([label, path]) => <li key={path}><a href={`${base}${path}`}>{label}</a></li>)}
        </ul>
      </details>
    </aside>
  )
}
