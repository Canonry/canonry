import type { DemoSiteInventory, DemoSiteLink, DemoSitePage } from '../seed-site-crawl.js'
import { HARBOR_MARKETS, harborProperties } from '../portfolio.js'

const SECTIONS = [
  ['rooms', ['ocean-suite', 'family-suite', 'garden-studio', 'accessible-suite', 'penthouse', 'two-bedroom-villa', 'king-room', 'connecting-rooms']],
  ['dining', ['waterfront-grill', 'poolside-cafe', 'lobby-bar', 'breakfast', 'private-dining']],
  ['amenities', ['pool', 'spa', 'fitness-center', 'beach', 'kids-club', 'pet-friendly-stays']],
  ['experiences', ['kayaking', 'sunset-cruise', 'local-food-tour', 'nature-trails', 'art-walk', 'family-activities']],
  ['offers', ['family-getaway', 'weekend-escape', 'extended-stay', 'spa-retreat']],
  ['meetings', ['ballroom', 'boardroom', 'waterfront-terrace']],
] as const

const GUIDE_TOPICS = ['getting-here', 'family-travel', 'seasonal-events', 'local-restaurants', 'weekend-itinerary'] as const

function parentOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 1 ? `/${parts.slice(0, -1).join('/')}/` : '/'
}

/**
 * A resort portfolio under one domain: destination hubs and guides, then 48
 * pages for each of 12 properties. Every page carries a home, section, and
 * property link in its template, and each property keeps one expired offer,
 * one retired room URL, one PDF, and one hidden confirmation page.
 */
export function harborResortsInventory(): DemoSiteInventory {
  const pages: DemoSitePage[] = []
  const links: DemoSiteLink[] = []
  const html = (path: string, score = 92) => pages.push({ path, kind: 'html', score })
  const content = (source: string, target: string) => links.push([source, target, 'content'])

  for (const path of ['/', '/destinations/', '/offers/', '/experiences/', '/guides/', '/contact/', '/services/']) html(path)
  for (const market of HARBOR_MARKETS) {
    html(`/destinations/${market.key}/`)
    html(`/destinations/${market.key}/guides/`)
    for (const topic of GUIDE_TOPICS) html(`/destinations/${market.key}/guides/${topic}/`, 82)
    content('/guides/', `/destinations/${market.key}/guides/`)
  }
  const properties = harborProperties()
  for (const [propertyIndex, property] of properties.entries()) {
    const home = `${property.path}/`
    html(home, 94)
    for (const [sectionIndex, [section, topics]] of SECTIONS.entries()) {
      html(`${home}${section}/`, 88 - propertyIndex % 5)
      for (const [topicIndex, topic] of topics.entries()) {
        const pagePath = `${home}${section}/${topic}/`
        html(pagePath, 94 - (propertyIndex * 7 + sectionIndex * 3 + topicIndex * 9) % 39)
        // Related-page cards and booking guidance connect each property's content.
        content(pagePath, `${home}${section}/${topics[(topicIndex + 1) % topics.length]}/`)
        content(pagePath, `${home}${section}/${topics[(topicIndex + 2) % topics.length]}/`)
        content(pagePath, `${home}offers/family-getaway/`)
        content(pagePath, `${home}amenities/spa/`)
      }
    }
    for (const section of ['gallery', 'location', 'faq', 'reviews', 'contact']) html(`${home}${section}/`, 86)
    pages.push(
      { path: `${home}booking-confirmation/`, kind: 'noindex', score: 90 },
      { path: `${home}offers/expired-summer-package/`, kind: 'broken' },
      { path: `${home}property-guide.pdf`, kind: 'resource', contentType: 'application/pdf' },
      { path: `${home}rooms/old-ocean-suite/`, kind: 'redirect', redirectTo: `${home}rooms/ocean-suite/` },
    )
    content('/offers/', `${home}offers/`)
    const siblings = properties.filter(candidate => candidate.market.key === property.market.key)
    content(home, `${siblings[property.number % siblings.length]!.path}/`)
    content(`/destinations/${property.market.key}/guides/family-travel/`, home)
  }
  for (const page of pages) {
    const parent = parentOf(page.path)
    if (page.path !== '/') content(parent, page.path)
    links.push([page.path, '/', 'navigation'], [page.path, parent, 'navigation'])
    const property = properties.find(candidate => page.path.startsWith(`${candidate.path}/`))
    if (property) links.push([page.path, `${property.path}/`, 'navigation'])
  }
  return { pages, templateLinks: [], links }
}
