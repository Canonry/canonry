import type { DemoSiteInventory, DemoSiteLink, DemoSitePage } from '../seed-site-crawl.js'

const SERVICES = [
  ['roof-replacement', ['asphalt-shingles', 'metal-roofing', 'tile-roofing', 'flat-roofing', 'cedar-shake']],
  ['roof-repair', ['leak-repair', 'storm-damage', 'emergency-tarping', 'flashing-repair', 'shingle-replacement']],
  ['roof-inspection', ['drone-inspection', 'insurance-claims', 'real-estate-inspection']],
  ['gutters', ['seamless-gutters', 'gutter-guards', 'downspouts']],
  ['skylights', ['skylight-installation', 'skylight-repair']],
  ['commercial-roofing', ['tpo-roofing', 'epdm-roofing', 'roof-coatings']],
  ['siding', ['vinyl-siding', 'fiber-cement-siding']],
] as const

type ServiceKey = (typeof SERVICES)[number][0]

/** Invented towns. The first six are the largest and have town-by-service pages. */
const TOWNS = [
  'alder-creek', 'birch-hollow', 'cedar-bluff', 'copper-ridge', 'elm-crossing', 'fox-meadow',
  'hawthorn-glen', 'ironwood-flats', 'juniper-springs', 'kestrel-point', 'larkspur-hills', 'millbrook',
  'north-quarry', 'oak-terrace', 'pine-hollow', 'quail-run', 'redfern', 'stonegate',
  'thistle-ridge', 'upper-brookside', 'vale-junction', 'willow-bend', 'yarrow-heights', 'zephyr-lake',
] as const

const TOWN_SERVICES = ['roof-replacement', 'roof-repair', 'gutters'] as const satisfies readonly ServiceKey[]

const PROJECT_TYPES = [
  ['metal-roof-replacement', 'roof-replacement', 'metal-roofing'],
  ['asphalt-shingle-roof', 'roof-replacement', 'asphalt-shingles'],
  ['storm-damage-repair', 'roof-repair', 'storm-damage'],
  ['seamless-gutter-install', 'gutters', 'seamless-gutters'],
  ['skylight-replacement', 'skylights', 'skylight-installation'],
  ['tpo-commercial-roof', 'commercial-roofing', 'tpo-roofing'],
  ['cedar-shake-restoration', 'roof-replacement', 'cedar-shake'],
  ['fiber-cement-siding', 'siding', 'fiber-cement-siding'],
  ['emergency-leak-repair', 'roof-repair', 'leak-repair'],
] as const

const GUIDE_TOPICS = ['materials', 'repair', 'insurance', 'maintenance', 'costs', 'commercial'] as const

const GUIDES: readonly (readonly [slug: string, service: ServiceKey, topic: (typeof GUIDE_TOPICS)[number]])[] = [
  ['how-much-does-a-roof-replacement-cost', 'roof-replacement', 'costs'],
  ['signs-you-need-a-new-roof', 'roof-replacement', 'maintenance'],
  ['metal-vs-asphalt-shingles', 'roof-replacement', 'materials'],
  ['how-long-does-a-roof-last', 'roof-replacement', 'materials'],
  ['roof-repair-vs-replacement', 'roof-repair', 'costs'],
  ['what-to-do-after-hail-damage', 'roof-repair', 'insurance'],
  ['filing-a-roof-insurance-claim', 'roof-inspection', 'insurance'],
  ['choosing-a-roofing-contractor', 'roof-replacement', 'costs'],
  ['ice-dam-prevention', 'roof-repair', 'maintenance'],
  ['how-to-spot-a-roof-leak', 'roof-repair', 'repair'],
  ['attic-ventilation-basics', 'roof-replacement', 'maintenance'],
  ['flat-roof-materials-compared', 'commercial-roofing', 'materials'],
  ['tpo-vs-epdm', 'commercial-roofing', 'commercial'],
  ['gutter-guard-types', 'gutters', 'maintenance'],
  ['when-to-replace-gutters', 'gutters', 'repair'],
  ['skylight-leak-causes', 'skylights', 'repair'],
  ['cedar-shake-maintenance', 'roof-replacement', 'maintenance'],
  ['tile-roof-lifespan', 'roof-replacement', 'materials'],
  ['roof-inspection-checklist', 'roof-inspection', 'maintenance'],
  ['what-a-roof-warranty-covers', 'roof-replacement', 'costs'],
  ['financing-a-new-roof', 'roof-replacement', 'costs'],
  ['storm-season-preparation', 'roof-repair', 'insurance'],
  ['emergency-tarping-what-to-expect', 'roof-repair', 'repair'],
  ['roof-flashing-explained', 'roof-repair', 'repair'],
  ['shingle-color-and-energy-costs', 'roof-replacement', 'materials'],
  ['roof-coatings-for-commercial-buildings', 'commercial-roofing', 'commercial'],
  ['vinyl-vs-fiber-cement-siding', 'siding', 'materials'],
  ['how-drone-roof-inspections-work', 'roof-inspection', 'insurance'],
  ['preparing-for-roof-replacement-day', 'roof-replacement', 'costs'],
  ['roof-replacement-timeline', 'roof-replacement', 'costs'],
  ['moss-and-algae-removal', 'roof-repair', 'maintenance'],
  ['chimney-flashing-repair', 'roof-repair', 'repair'],
  ['roof-underlayment-types', 'roof-replacement', 'materials'],
  ['solar-ready-roofing', 'roof-replacement', 'materials'],
  ['commercial-roof-maintenance-plans', 'commercial-roofing', 'commercial'],
  ['downspout-drainage-tips', 'gutters', 'maintenance'],
  ['real-estate-roof-inspections', 'roof-inspection', 'insurance'],
  ['winter-roof-care', 'roof-repair', 'maintenance'],
  ['wind-damage-signs', 'roof-repair', 'insurance'],
  ['roof-pitch-explained', 'roof-replacement', 'materials'],
  ['recycling-old-shingles', 'roof-replacement', 'materials'],
  ['metal-roof-noise', 'roof-replacement', 'materials'],
  ['what-to-ask-before-signing', 'roof-replacement', 'costs'],
  ['skylight-sizing-guide', 'skylights', 'materials'],
]

const HEADER = ['/', '/services/', '/service-areas/', '/projects/', '/reviews/', '/financing/', '/about/', '/contact/', '/get-a-quote/']
const FOOTER = [
  '/services/roof-replacement/', '/services/roof-repair/', '/services/gutters/', '/services/commercial-roofing/',
  '/guides/', '/about/warranty/', '/careers/', '/contact/', '/privacy-policy/', '/terms/', '/accessibility/',
]

/** Sitemap-only pages that nothing links to. */
const ORPHAN_TOWN_SERVICE = `/service-areas/${TOWNS[5]}/gutters/`
const THIN_TOWN_SERVICES = new Set([
  `/service-areas/${TOWNS[2]}/roof-repair/`, `/service-areas/${TOWNS[3]}/gutters/`,
  `/service-areas/${TOWNS[4]}/roof-repair/`, `/service-areas/${TOWNS[5]}/roof-replacement/`,
])
const THIN_PROJECTS = new Set([8, 19, 30])

const service = (key: string) => `/services/${key}/`
const town = (key: string) => `/service-areas/${key}/`
const guide = (slug: string) => `/guides/${slug}/`

/**
 * A local roofing contractor on summit-roofing.example: services and
 * sub-services, invented service towns, completed projects, guides, financing,
 * and a quote flow. It keeps the faults a real site of this size tends to
 * carry: moved URLs still linked from old pages, broken links, noindex steps,
 * paginated archives with a canonical, thin pages, and sitemap-only orphans.
 */
export function summitRoofingInventory(): DemoSiteInventory {
  const pages: DemoSitePage[] = []
  const links: DemoSiteLink[] = []
  const link = (source: string, ...targets: string[]) => { for (const target of targets) links.push([source, target]) }
  const projects = Array.from({ length: 36 }, (_, index) => {
    const [type, category, sub] = PROJECT_TYPES[index % PROJECT_TYPES.length]!
    const townKey = TOWNS[index % TOWNS.length]!
    return { index, path: `/projects/${townKey}-${type}/`, townKey, category, sub }
  })

  pages.push(
    { path: '/', kind: 'html', score: 88 },
    { path: '/llms.txt', kind: 'resource', contentType: 'text/plain; charset=utf-8', sitemap: true },
    { path: '/services/', kind: 'html', score: 84 },
  )
  link('/', ...SERVICES.map(([key]) => service(key)), '/service-areas/', ...projects.slice(0, 3).map(project => project.path),
    guide(GUIDES[0]![0]), guide(GUIDES[2]![0]), guide(GUIDES[5]![0]), '/reviews/', '/financing/', '/get-a-quote/')
  link('/services/', ...SERVICES.map(([key]) => service(key)), '/service-areas/')

  for (const [categoryIndex, [category, subs]] of SERVICES.entries()) {
    pages.push({ path: service(category), kind: 'html', score: 86 - categoryIndex * 2 })
    const categoryGuides = GUIDES.filter(([, key]) => key === category)
    const categoryProjects = projects.filter(project => project.category === category)
    link(service(category), ...subs.map(sub => service(`${category}/${sub}`)), '/get-a-quote/', '/financing/',
      ...categoryGuides.slice(0, 2).map(([slug]) => guide(slug)), ...categoryProjects.slice(0, 2).map(project => project.path))
    for (const [subIndex, sub] of subs.entries()) {
      const path = service(`${category}/${sub}`)
      pages.push({ path, kind: 'html', score: 83 - (subIndex * 7 + categoryIndex * 3) % 17 })
      const project = categoryProjects.find(candidate => candidate.sub === sub) ?? categoryProjects.at(0)
      link(path, service(category), service(`${category}/${subs[(subIndex + 1) % subs.length]}`), '/get-a-quote/')
      if (project) link(path, project.path)
      const related = categoryGuides.at(subIndex % Math.max(1, categoryGuides.length))
      if (related) link(path, guide(related[0]))
    }
  }

  pages.push({ path: '/service-areas/', kind: 'html', score: 78 })
  link('/service-areas/', ...TOWNS.map(town))
  for (const [townIndex, townKey] of TOWNS.entries()) {
    pages.push({ path: town(townKey), kind: 'html', score: 76 - (townIndex % 6) * 2, factorScores: { 'geographic-signals': 92 } })
    link(town(townKey), service('roof-replacement'), service('roof-repair'), service('gutters'), service('roof-inspection'),
      town(TOWNS[(townIndex + 1) % TOWNS.length]!), ...projects.filter(project => project.townKey === townKey).map(project => project.path),
      '/reviews/', '/get-a-quote/')
    if (townIndex >= 6) continue
    for (const serviceKey of TOWN_SERVICES) {
      const path = `${town(townKey)}${serviceKey}/`
      const thin = THIN_TOWN_SERVICES.has(path)
      pages.push({ path, kind: 'html', score: thin ? 58 : 72, factorScores: thin ? { 'content-depth': 34, 'geographic-signals': 88 } : { 'geographic-signals': 94 } })
      link(path, town(townKey), service(serviceKey), '/get-a-quote/')
      if (path !== ORPHAN_TOWN_SERVICE) link(town(townKey), path)
    }
  }

  pages.push({ path: '/projects/', kind: 'html', score: 80 })
  link('/projects/', ...projects.map(project => project.path))
  for (const project of projects) {
    const thin = THIN_PROJECTS.has(project.index)
    pages.push({ path: project.path, kind: 'html', score: thin ? 60 : 77 - (project.index % 7) * 2, factorScores: thin ? { 'content-depth': 31 } : undefined })
    link(project.path, service(project.category), service(`${project.category}/${project.sub}`), town(project.townKey),
      projects[(project.index + 1) % projects.length]!.path, '/get-a-quote/', '/reviews/')
  }

  pages.push(
    { path: '/guides/', kind: 'html', score: 83 },
    { path: '/guides/page/2/', kind: 'canonicalized', canonicalTo: '/guides/', score: 72 },
    { path: '/guides/page/3/', kind: 'canonicalized', canonicalTo: '/guides/', score: 70 },
    { path: '/guides/topic/', kind: 'noindex', score: 70 },
    { path: '/guides/roof-maintenance-checklist.pdf', kind: 'resource', contentType: 'application/pdf' },
  )
  link('/guides/', ...GUIDES.slice(0, 20).map(([slug]) => guide(slug)), '/guides/page/2/', '/guides/topic/')
  link('/guides/page/2/', ...GUIDES.slice(20, 40).map(([slug]) => guide(slug)), '/guides/', '/guides/page/3/')
  link('/guides/page/3/', ...GUIDES.slice(40).map(([slug]) => guide(slug)), '/guides/page/2/')
  link('/guides/topic/', ...GUIDE_TOPICS.map(topic => `/guides/topic/${topic}/`))
  for (const topic of GUIDE_TOPICS) {
    pages.push({ path: `/guides/topic/${topic}/`, kind: 'noindex', score: 68 })
    link(`/guides/topic/${topic}/`, '/guides/', ...GUIDES.filter(([, , guideTopic]) => guideTopic === topic).map(([slug]) => guide(slug)))
  }
  for (const [guideIndex, [slug, serviceKey, topic]] of GUIDES.entries()) {
    const noAuthor = guideIndex % 5 === 4
    pages.push({ path: guide(slug), kind: 'html', score: 81 - (guideIndex % 6) * 3, factorScores: noAuthor ? { 'eeat-signals': 28 } : undefined })
    link(guide(slug), service(serviceKey), guide(GUIDES[(guideIndex + 1) % GUIDES.length]![0]), `/guides/topic/${topic}/`, '/get-a-quote/')
  }
  link(guide(GUIDES[18]![0]), '/guides/roof-maintenance-checklist.pdf')
  link(guide('what-a-roof-warranty-covers'), '/about/warranty/')

  pages.push(
    { path: '/financing/', kind: 'html', score: 79 },
    { path: '/financing/apply/', kind: 'html', score: 71 },
    { path: '/financing/faq/', kind: 'html', score: 86, factorScores: { 'faq-content': 95 } },
    { path: '/financing/financing-terms.pdf', kind: 'resource', contentType: 'application/pdf' },
    { path: '/reviews/', kind: 'html', score: 85 },
    { path: '/reviews/leave-a-review/', kind: 'noindex', score: 60 },
    { path: '/about/', kind: 'html', score: 82 },
    { path: '/about/team/', kind: 'html', score: 80, factorScores: { 'eeat-signals': 93 } },
    { path: '/about/certifications/', kind: 'html', score: 83 },
    { path: '/about/warranty/', kind: 'html', score: 81 },
    { path: '/about/community/', kind: 'html', score: 72 },
    { path: '/about/warranty/warranty-guide.pdf', kind: 'resource', contentType: 'application/pdf' },
    { path: '/careers/', kind: 'html', score: 70 },
    { path: '/careers/roofing-crew-lead/', kind: 'html', score: 66 },
    { path: '/careers/project-manager/', kind: 'html', score: 67 },
    { path: '/careers/sales-estimator/', kind: 'html', score: 65 },
    { path: '/contact/', kind: 'html', score: 84 },
    { path: '/contact/thank-you/', kind: 'noindex', score: 50 },
    { path: '/get-a-quote/', kind: 'html', score: 80 },
    { path: '/get-a-quote/roof-details/', kind: 'noindex', score: 62 },
    { path: '/get-a-quote/schedule/', kind: 'noindex', score: 62 },
    { path: '/get-a-quote/thank-you/', kind: 'noindex', score: 50 },
    { path: '/privacy-policy/', kind: 'html', score: 64 },
    { path: '/terms/', kind: 'html', score: 63 },
    { path: '/accessibility/', kind: 'html', score: 69 },
  )
  link('/financing/', '/financing/apply/', '/financing/faq/', '/financing/financing-terms.pdf', '/get-a-quote/')
  link('/financing/faq/', '/financing/apply/')
  link('/reviews/', '/reviews/leave-a-review/', ...projects.slice(0, 6).map(project => project.path))
  link('/about/', '/about/team/', '/about/certifications/', '/about/warranty/', '/about/community/', '/reviews/')
  link('/about/warranty/', '/about/warranty/warranty-guide.pdf', guide('what-a-roof-warranty-covers'))
  link('/about/certifications/', service('roof-replacement'))
  link('/about/community/', '/projects/')
  link('/careers/', '/careers/roofing-crew-lead/', '/careers/project-manager/', '/careers/sales-estimator/')
  for (const role of ['roofing-crew-lead', 'project-manager', 'sales-estimator']) link(`/careers/${role}/`, '/careers/')
  link('/contact/', '/contact/thank-you/')
  link('/get-a-quote/', '/get-a-quote/roof-details/', '/financing/')
  link('/get-a-quote/roof-details/', '/get-a-quote/schedule/')
  link('/get-a-quote/schedule/', '/get-a-quote/thank-you/')

  // Moved pages. Each old URL still has at least one page linking to it.
  pages.push(
    { path: '/roof-repair/', kind: 'redirect', redirectTo: service('roof-repair') },
    { path: '/blog/', kind: 'redirect', redirectTo: '/guides/' },
    { path: '/services/metal-roofs/', kind: 'redirect', redirectTo: service('roof-replacement/metal-roofing') },
    { path: '/guides/ice-dam-prevention-2023/', kind: 'redirect', redirectTo: guide('ice-dam-prevention') },
    { path: '/service-areas/old-county/', kind: 'redirect', redirectTo: '/service-areas/' },
    { path: '/free-estimate/', kind: 'redirect', redirectTo: '/get-a-quote/' },
  )
  link(service('roof-repair/leak-repair'), '/roof-repair/')
  link(guide('how-to-spot-a-roof-leak'), '/roof-repair/')
  link(guide('signs-you-need-a-new-roof'), '/blog/')
  link(guide('roof-repair-vs-replacement'), '/blog/')
  link(guide('metal-vs-asphalt-shingles'), '/services/metal-roofs/')
  link(guide('winter-roof-care'), '/guides/ice-dam-prevention-2023/')
  link(town(TOWNS.at(-1)!), '/service-areas/old-county/')
  link(projects[0]!.path, '/free-estimate/')
  link('/financing/faq/', '/free-estimate/')

  // Broken links: removed pages that other pages still point at.
  pages.push(
    { path: '/careers/estimator-2025/', kind: 'broken' },
    { path: '/financing/spring-promo/', kind: 'broken' },
    { path: '/guides/hail-season-update/', kind: 'broken' },
    { path: `/projects/${TOWNS[2]}-reroof-draft/`, kind: 'broken' },
  )
  link('/careers/', '/careers/estimator-2025/')
  link('/financing/', '/financing/spring-promo/')
  link(guide('what-to-do-after-hail-damage'), '/guides/hail-season-update/')
  link(guide('storm-season-preparation'), '/guides/hail-season-update/')
  link('/projects/', `/projects/${TOWNS[2]}-reroof-draft/`)

  // Sitemap-only orphans. The town-by-service orphan was added above without an inbound link.
  pages.push(
    { path: '/spring-roof-special/', kind: 'html', score: 52, factorScores: { 'content-freshness': 18 } },
    { path: '/guides/choosing-roof-color/', kind: 'html', score: 74 },
  )
  link('/spring-roof-special/', '/get-a-quote/')
  link('/guides/choosing-roof-color/', service('roof-replacement'))

  return { pages, templateLinks: [...HEADER, ...FOOTER], links }
}
