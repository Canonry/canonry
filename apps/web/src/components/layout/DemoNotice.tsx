import { useId } from 'react'
import { ArrowUpRight, ChevronDown, Github } from 'lucide-react'
import { getPublicBase, isPublicDemo } from '../../api.js'

const REPOSITORY_URL = 'https://github.com/Canonry/canonry'
const WEBSITE_URL = 'https://canonry.ai'
const AGENT_SENTENCE = 'Run it from your agent with the MCP server, API, CLI, and plugins for Claude Code and Codex.'

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
    ['Site health', '/projects/summit-roofing/technical-aeo'],
    ['Local presence', '/projects/summit-roofing/local'],
    ['Backlinks', '/projects/summit-roofing/backlinks'],
  ] },
] as const

export function DemoNotice() {
  const ids = useId()
  if (!isPublicDemo()) return null
  const base = getPublicBase()
  const newTabId = `${ids}-new-tab`
  const external = { target: '_blank', rel: 'noopener noreferrer', 'aria-describedby': newTabId } as const
  return (
    <aside className="demo-banner" aria-label="Public demo">
      <p className="demo-banner-name">Canonry demo</p>
      <p className="demo-banner-facts">No sign-in. View only. Fictional data.</p>
      <p className="demo-banner-agent">{AGENT_SENTENCE}</p>
      <div className="demo-banner-actions">
        <a className="demo-banner-primary" href={WEBSITE_URL} {...external}>
          canonry.ai
          <ArrowUpRight aria-hidden="true" size={14} />
        </a>
        <a className="demo-banner-secondary" href={REPOSITORY_URL} {...external}>
          <Github aria-hidden="true" size={15} />
          GitHub
        </a>
        <details onKeyDown={(event) => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
          <summary>Explore <ChevronDown aria-hidden="true" size={14} /></summary>
          <div className="demo-banner-panel">
            <p className="demo-banner-panel-agent">{AGENT_SENTENCE}</p>
            <nav className="demo-banner-examples" aria-label="Demo examples">
              <a href={`${base}/projects/summit-roofing`}>Standard business</a>
              <a href={`${base}/projects/harbor-resorts`}>Property portfolio</a>
            </nav>
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
          </div>
        </details>
      </div>
      <span id={newTabId} hidden>Opens in a new tab</span>
    </aside>
  )
}
