import { useId, useState, type ReactNode } from 'react'
import { ArrowUpRight, Braces, ChevronDown, Github, Puzzle, Server, SquareTerminal, type LucideIcon } from 'lucide-react'
import { getPublicBase, isPublicDemo } from '../../api.js'

const REPOSITORY_URL = 'https://github.com/Canonry/canonry'
const WEBSITE_URL = 'https://canonry.ai'

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

const AGENT_TOOLS: readonly { label: string, detail: ReactNode, href: string, Icon: LucideIcon }[] = [
  { label: 'MCP server', detail: <>Local or hosted, with <span className="demo-banner-nowrap">read-only</span> mode</>, href: `${REPOSITORY_URL}/blob/main/docs/mcp.md`, Icon: Server },
  { label: 'REST API', detail: 'Documented with an OpenAPI spec', href: `${REPOSITORY_URL}#self-hosting-and-api`, Icon: Braces },
  { label: 'CLI', detail: 'JSON output for scripts and agents', href: `${REPOSITORY_URL}/blob/main/skills/canonry/references/canonry-cli.md`, Icon: SquareTerminal },
  { label: 'Plugins and skills', detail: 'For Claude Code and Codex', href: `${REPOSITORY_URL}/blob/main/docs/plugins.md`, Icon: Puzzle },
]

export function DemoNotice() {
  const ids = useId()
  const [toolsOpen, setToolsOpen] = useState(false)
  if (!isPublicDemo()) return null
  const base = getPublicBase()
  const exploreHeadingId = `${ids}-explore`
  const agentHeadingId = `${ids}-agent`
  const toolsId = `${ids}-tools`
  const newTabId = `${ids}-new-tab`
  const external = { target: '_blank', rel: 'noopener noreferrer', 'aria-describedby': newTabId } as const
  return (
    <aside className="demo-banner" aria-label="Public demo">
      <section className="demo-banner-explore" aria-labelledby={exploreHeadingId}>
        <h2 id={exploreHeadingId} className="demo-banner-title">Explore Canonry</h2>
        <ul className="demo-banner-facts">
          <li>No sign-in</li>
          <li>View only</li>
          <li>Fictional data</li>
        </ul>
        <div className="demo-banner-explore-links">
          <nav aria-label="Demo examples">
            <a href={`${base}/projects/summit-roofing`}>Standard business</a>
            <a href={`${base}/projects/harbor-resorts`}>Property portfolio</a>
          </nav>
          <details onKeyDown={(event) => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
            <summary>Explore features <ChevronDown aria-hidden="true" size={14} /></summary>
            <nav className="demo-banner-features" aria-label="Demo feature directory">
              {FEATURE_GROUPS.map(({ title, links }) => (
                <section key={title} aria-label={title}>
                  <h3>{title}</h3>
                  <ul>
                    {links.map(([label, path]) => <li key={path}><a href={`${base}${path}`}>{label}</a></li>)}
                  </ul>
                </section>
              ))}
            </nav>
          </details>
        </div>
      </section>
      <section className="demo-banner-agent" aria-labelledby={agentHeadingId}>
        <h2 id={agentHeadingId} className="demo-banner-title demo-banner-agent-heading">Run it with your own agent</h2>
        <div className="demo-banner-actions">
          <a className="demo-banner-primary" href={REPOSITORY_URL} {...external}>
            <Github aria-hidden="true" size={16} />
            View on GitHub
          </a>
          <a className="demo-banner-secondary" href={WEBSITE_URL} {...external}>
            canonry.ai
            <ArrowUpRight aria-hidden="true" size={14} />
          </a>
        </div>
        <h2 className="demo-banner-title demo-banner-agent-toggle-heading">
          <button type="button" className="demo-banner-agent-toggle" aria-expanded={toolsOpen} aria-controls={toolsId} onClick={() => setToolsOpen((open) => !open)}>
            Run it with your own agent
            <ChevronDown aria-hidden="true" size={16} />
          </button>
        </h2>
        <ul id={toolsId} className="demo-banner-tools" data-open={toolsOpen ? 'true' : 'false'}>
          {AGENT_TOOLS.map(({ label, detail, href, Icon }) => (
            <li key={href}>
              <a className="demo-banner-tool" href={href} {...external}>
                <Icon aria-hidden="true" size={16} />
                <span className="demo-banner-tool-label">{label}</span>
                <span className="demo-banner-tool-detail">{detail}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
      <span id={newTabId} hidden>Opens in a new tab</span>
    </aside>
  )
}
