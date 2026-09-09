import { ChevronDown } from 'lucide-react'
import { getPublicBase, isPublicDemo } from '../../api.js'

const FEATURE_GROUPS = [
  { title: 'Visibility', links: [
    ['AI visibility', '/projects/summit-roofing'],
    ['Search engines', '/projects/summit-roofing/search-console'],
    ['Traffic & conversions', '/projects/summit-roofing/conversions'],
    ['Reports', '/projects/harbor-resorts/report'],
  ] },
  { title: 'Portfolio', links: [
    ['Properties & markets', '/projects/harbor-resorts'],
    ['Queries & research', '/projects/harbor-resorts/queries'],
    ['Activity', '/projects/harbor-resorts/activity'],
  ] },
  { title: 'Website', links: [
    ['Site health', '/projects/harbor-resorts/technical-aeo'],
    ['Local presence', '/projects/summit-roofing/local'],
    ['Backlinks', '/projects/summit-roofing/backlinks'],
  ] },
] as const

export function DemoNotice() {
  if (!isPublicDemo()) return null
  const base = getPublicBase()
  return (
    <aside className="demo-banner" aria-label="Public demo">
      <div className="demo-banner-top">
        <div className="demo-banner-intro">
          <strong>Explore Canonry</strong>
          <span>View-only demo with fictional sample data.</span>
        </div>
        <div className="demo-banner-controls">
          <nav aria-label="Demo examples">
            <a href={`${base}/projects/summit-roofing`}>Standard business</a>
            <a href={`${base}/projects/harbor-resorts`}>Property portfolio</a>
          </nav>
          <details onKeyDown={(event) => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
            <summary>Explore features <ChevronDown aria-hidden="true" size={14} /></summary>
            <nav className="demo-banner-features" aria-label="Demo feature directory">
              {FEATURE_GROUPS.map(({ title, links }) => (
                <section key={title} aria-label={title}>
                  <h2>{title}</h2>
                  <ul>
                    {links.map(([label, path]) => <li key={path}><a href={`${base}${path}`}>{label}</a></li>)}
                  </ul>
                </section>
              ))}
            </nav>
          </details>
        </div>
      </div>
      <p className="demo-banner-agent">Everything here, and much more, is available to <strong>your company’s agent through MCP and the API</strong> in your own Canonry instance.</p>
    </aside>
  )
}
