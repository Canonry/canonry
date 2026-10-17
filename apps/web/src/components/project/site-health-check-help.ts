export const SITE_HEALTH_CHECK_HELP: Readonly<Record<string, string | undefined>> = {
  'geographic-signals': 'Checks whether pages say where your business operates: your address, service areas, map coordinates, and location details that search engines can read. Useful for businesses serving specific places. Off by default; enabling it adds this check to the health score.',
  'agent-skill-exposure': 'Checks whether AI agents can understand your forms, discover actions such as site search, and find links to tools or APIs. Reads page information only; it does not submit forms or run actions. Included in the health score by default.',
}
