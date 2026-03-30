import crypto from 'node:crypto'
import type {
  WordpressAuditIssueDto,
  WordpressAuditPageDto,
  WordpressBulkMetaEntryResultDto,
  WordpressBulkMetaResultDto,
  WordpressDiffDto,
  WordpressDiffPageDto,
  WordpressEnv,
  WordpressManualAssistDto,
  WordpressPageDetailDto,
  WordpressPageSummaryDto,
  WordpressSchemaBlockDto,
  WordpressSchemaDeployEntryResultDto,
  WordpressSchemaDeployResultDto,
  WordpressSchemaStatusPageDto,
  WordpressSchemaStatusResultDto,
  WordpressSeoStateDto,
  WordpressSiteStatusDto,
} from '@ainyc/canonry-contracts'
import { wordpressEnvSchema } from '@ainyc/canonry-contracts'
import type { WordpressConnectionRecord, WordpressRestPage, WordpressSiteContext } from './types.js'
import { WordpressApiError } from './types.js'
import type { BusinessProfile, SchemaPageEntry, SchemaProfileFile } from './schema-templates.js'
import { generateSchema, isSupportedSchemaType, parseSchemaPageEntry } from './schema-templates.js'

const PAGE_FIELDS = 'id,slug,status,link,modified,modified_gmt,title,content,meta'
const PAGE_LIST_FIELDS = 'id,slug,status,link,modified,modified_gmt,title'
const VERIFY_PAGE_FIELDS = 'id,status'
const VERIFY_USER_FIELDS = 'id,slug'
const SEO_TARGETS = [
  {
    pluginHints: ['wordpress-seo', 'yoast'],
    titleKey: '_yoast_wpseo_title',
    descriptionKey: '_yoast_wpseo_metadesc',
    noindexKey: '_yoast_wpseo_meta-robots-noindex',
  },
  {
    pluginHints: ['all-in-one-seo-pack', 'aioseo'],
    titleKey: '_aioseo_title',
    descriptionKey: '_aioseo_description',
    noindexKey: '_aioseo_noindex',
  },
  {
    pluginHints: ['seo-by-rank-math', 'rank-math'],
    titleKey: 'rank_math_title',
    descriptionKey: 'rank_math_description',
    noindexKey: 'rank_math_robots',
  },
] as const
const THIN_CONTENT_WORD_COUNT = 250

function normalizeSiteUrl(url: string): string {
  return url.replace(/\/$/, '')
}

function encodeBasicAuth(username: string, appPassword: string): string {
  return Buffer.from(`${username}:${appPassword}`).toString('base64')
}

function buildAuthErrorMessage(res: Response, responseText: string): string {
  let wordpressCode: string | null = null
  try {
    const parsed = JSON.parse(responseText) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const payload = parsed as Record<string, unknown>
      if (typeof payload.code === 'string') wordpressCode = payload.code
    }
  } catch {
    // ignore parse errors
  }

  if (res.status === 401 && wordpressCode === 'rest_not_logged_in') {
    return 'Authentication failed — the username or application password is incorrect. Verify the app password belongs to the user specified with --user.'
  }

  if ((res.status === 401 || res.status === 403) && wordpressCode) {
    return 'Authenticated but lacking permission — check that the user has Administrator or Editor role.'
  }

  return 'WordPress credentials are invalid or lack permission for this action'
}

async function fetchJson<T>(
  connection: WordpressConnectionRecord,
  siteUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ body: T; response: Response }> {
  const res = await fetch(`${normalizeSiteUrl(siteUrl)}${path}`, {
    ...init,
    headers: {
      'Authorization': `Basic ${encodeBasicAuth(connection.username, connection.appPassword)}`,
      ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })

  if (res.status === 401 || res.status === 403) {
    const text = await res.text().catch(() => '')
    throw new WordpressApiError('AUTH_INVALID', buildAuthErrorMessage(res, text), res.status)
  }

  if (res.status === 404) {
    throw new WordpressApiError('NOT_FOUND', 'WordPress endpoint not found', 404)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new WordpressApiError('UPSTREAM_ERROR', `WordPress API error (${res.status}): ${text || res.statusText}`, res.status)
  }

  return {
    body: (await res.json()) as T,
    response: res,
  }
}

async function verifyAuthenticatedRestAccess(
  connection: WordpressConnectionRecord,
  siteUrl: string,
): Promise<{ id: number; slug: string }> {
  const { body } = await fetchJson<{ id: number; slug: string }>(
    connection,
    siteUrl,
    `/wp-json/wp/v2/users/me?_fields=${VERIFY_USER_FIELDS}`,
  )
  return { id: body.id, slug: body.slug }
}

async function fetchPageCollectionSummary(
  connection: WordpressConnectionRecord,
  siteUrl: string,
  options?: { context?: 'view' | 'edit' },
): Promise<Response> {
  const params = new URLSearchParams({
    per_page: '1',
    _fields: VERIFY_PAGE_FIELDS,
  })
  if (options?.context) {
    params.set('context', options.context)
  }

  const { response } = await fetchJson<WordpressRestPage[]>(
    connection,
    siteUrl,
    `/wp-json/wp/v2/pages?${params.toString()}`,
  )
  return response
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractMetaContent(html: string, name: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name}["'][^>]*>`, 'i'),
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match?.[1] != null) return match[1].trim() || null
  }
  return null
}

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match?.[1] ? stripHtml(match[1]) || null : null
}

function extractGeneratorVersion(html: string): string | null {
  const generator = extractMetaContent(html, 'generator')
  if (!generator) return null
  const match = /WordPress\s+([0-9][^ ]*)/i.exec(generator)
  return match?.[1] ?? generator
}

function extractSchemaBlocks(html: string): WordpressSchemaBlockDto[] {
  const blocks: WordpressSchemaBlockDto[] = []
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(html)) !== null) {
    const raw = match[1]?.trim()
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> | Record<string, unknown>[]
      const items = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of items) {
        const type = typeof item['@type'] === 'string'
          ? String(item['@type'])
          : Array.isArray(item['@type'])
            ? String(item['@type'][0] ?? 'Unknown')
            : 'Unknown'
        blocks.push({
          type,
          json: item,
        })
      }
    } catch {
      continue
    }
  }
  return blocks
}

function summarizeSeoFromHtml(html: string): Pick<WordpressSeoStateDto, 'title' | 'description' | 'noindex'> {
  const description = extractMetaContent(html, 'description')
  const robots = extractMetaContent(html, 'robots')
  return {
    title: extractTitle(html),
    description,
    noindex: robots == null ? null : /\bnoindex\b/i.test(robots),
  }
}

function computeWordCount(content: string): number {
  const clean = stripHtml(content)
  if (!clean) return 0
  return clean.split(/\s+/).filter(Boolean).length
}

function buildSnippet(content: string): string {
  const text = stripHtml(content)
  if (text.length <= 160) return text
  return `${text.slice(0, 157)}...`
}

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function buildAmbiguousSlugMessage(slug: string, pages: WordpressRestPage[]): string {
  const candidates = pages
    .map((page) => {
      const title = stripHtml(page.title?.rendered ?? '') || '(untitled)'
      return `#${page.id} "${title}"`
    })
    .join(', ')
  return `Multiple pages matched slug "${slug}". Candidates: ${candidates}.`
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  iteratee: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await iteratee(items[index]!, index)
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

function resolveSeoWriteTargets(
  meta: Record<string, unknown> | undefined,
  plugins: string[] | null,
): WordpressSeoStateDto['writeTargets'] {
  if (!meta) return []
  const keys = new Set(Object.keys(meta))
  const pluginList = plugins ?? []
  const targets: string[] = []

  for (const target of SEO_TARGETS) {
    const hinted = target.pluginHints.some((hint) => pluginList.some((plugin) => plugin.includes(hint)))
    if (!hinted && !keys.has(target.titleKey) && !keys.has(target.descriptionKey) && !keys.has(target.noindexKey)) {
      continue
    }
    if (keys.has(target.titleKey)) targets.push(target.titleKey)
    if (keys.has(target.descriptionKey)) targets.push(target.descriptionKey)
    if (keys.has(target.noindexKey)) targets.push(target.noindexKey)
  }

  return [...new Set(targets)]
}

function buildSeoState(
  page: WordpressRestPage,
  html: string | null,
  plugins: string[] | null,
): WordpressSeoStateDto {
  const renderedSeo = html ? summarizeSeoFromHtml(html) : { title: null, description: null, noindex: null }
  const writeTargets = resolveSeoWriteTargets(page.meta, plugins)
  return {
    title: renderedSeo.title,
    description: renderedSeo.description,
    noindex: renderedSeo.noindex,
    writable: writeTargets.length > 0,
    writeTargets,
  }
}

export function resolveEnvironment(
  connection: WordpressConnectionRecord,
  requestedEnv?: WordpressEnv,
): WordpressSiteContext {
  const env = requestedEnv ?? connection.defaultEnv
  if (env === 'staging') {
    if (!connection.stagingUrl) {
      throw new WordpressApiError('VALIDATION_ERROR', 'No staging URL configured for this project. Reconnect with --staging-url or use --live.', 400)
    }
    return { env, siteUrl: normalizeSiteUrl(connection.stagingUrl) }
  }

  return { env: 'live', siteUrl: normalizeSiteUrl(connection.url) }
}

export function getWpStagingAdminUrl(url: string): string {
  return `${normalizeSiteUrl(url)}/wp-admin/admin.php?page=wpstg_clone`
}

export async function verifyWordpressConnection(
  connection: WordpressConnectionRecord,
): Promise<WordpressSiteStatusDto> {
  const site = resolveEnvironment({ ...connection, defaultEnv: 'live' }, 'live')
  const userInfo = await verifyAuthenticatedRestAccess(connection, site.siteUrl)
  const response = await fetchPageCollectionSummary(connection, site.siteUrl, { context: 'view' })
  const homeHtml = await fetchText(site.siteUrl)
  return {
    url: site.siteUrl,
    reachable: true,
    pageCount: Number.parseInt(response.headers.get('x-wp-total') ?? '0', 10) || 0,
    version: homeHtml ? extractGeneratorVersion(homeHtml) : null,
    plugins: [],
    authenticatedUser: userInfo,
  }
}

export async function getSiteStatus(
  connection: WordpressConnectionRecord,
  env: WordpressEnv,
): Promise<WordpressSiteStatusDto> {
  const site = resolveEnvironment(connection, env)
  try {
    const userInfo = await verifyAuthenticatedRestAccess(connection, site.siteUrl)
    const response = await fetchPageCollectionSummary(connection, site.siteUrl, { context: 'view' })
    const homeHtml = await fetchText(site.siteUrl)
    const plugins = await listActivePlugins(connection, env)
    return {
      url: site.siteUrl,
      reachable: true,
      pageCount: Number.parseInt(response.headers.get('x-wp-total') ?? '0', 10) || 0,
      version: homeHtml ? extractGeneratorVersion(homeHtml) : null,
      plugins: plugins ?? [],
      authenticatedUser: userInfo,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      url: site.siteUrl,
      reachable: false,
      pageCount: null,
      version: null,
      error: message,
      plugins: [],
    }
  }
}

export async function listActivePlugins(
  connection: WordpressConnectionRecord,
  env: WordpressEnv,
): Promise<string[] | null> {
  const site = resolveEnvironment(connection, env)
  try {
    const { body } = await fetchJson<Array<{ plugin: string; status: string }>>(
      connection,
      site.siteUrl,
      '/wp-json/wp/v2/plugins?per_page=100&_fields=plugin,status',
    )
    return body
      .filter((plugin) => plugin.status === 'active')
      .map((plugin) => plugin.plugin)
      .sort()
  } catch (error) {
    if (error instanceof WordpressApiError && (error.statusCode === 403 || error.statusCode === 404)) {
      return null
    }
    return null
  }
}

export async function listPages(
  connection: WordpressConnectionRecord,
  env?: WordpressEnv,
): Promise<WordpressPageSummaryDto[]> {
  const site = resolveEnvironment(connection, env)
  const pages: WordpressPageSummaryDto[] = []
  let page = 1
  let totalPages = 1

  while (page <= totalPages) {
    const { body, response } = await fetchJson<WordpressRestPage[]>(
      connection,
      site.siteUrl,
      `/wp-json/wp/v2/pages?per_page=100&page=${page}&context=edit&_fields=${PAGE_LIST_FIELDS}`,
    )

    totalPages = Number.parseInt(response.headers.get('x-wp-totalpages') ?? '1', 10) || 1
    pages.push(...body.map((entry) => ({
      id: entry.id,
      slug: entry.slug,
      title: stripHtml(entry.title?.rendered ?? ''),
      status: entry.status,
      modifiedAt: entry.modified ?? entry.modified_gmt ?? null,
      link: entry.link ?? null,
    })))
    page += 1
  }

  return pages
}

export async function getPageBySlug(
  connection: WordpressConnectionRecord,
  slug: string,
  env?: WordpressEnv,
): Promise<WordpressRestPage> {
  const site = resolveEnvironment(connection, env)
  const { body } = await fetchJson<WordpressRestPage[]>(
    connection,
    site.siteUrl,
    `/wp-json/wp/v2/pages?slug=${encodeURIComponent(slug)}&per_page=100&context=edit&_fields=${PAGE_FIELDS}`,
  )

  if (body.length === 0) {
    throw new WordpressApiError('NOT_FOUND', `No WordPress page found for slug "${slug}"`, 404)
  }

  const exact = body.filter((page) => page.slug === slug)
  if (exact.length === 1) return exact[0]!
  if (exact.length > 1) {
    throw new WordpressApiError('VALIDATION_ERROR', buildAmbiguousSlugMessage(slug, exact), 400)
  }

  if (body.length > 1) {
    throw new WordpressApiError('VALIDATION_ERROR', buildAmbiguousSlugMessage(slug, body), 400)
  }

  return body[0]!
}

async function fetchRenderedPage(link: string | undefined | null): Promise<string | null> {
  if (!link) return null
  return fetchText(link)
}

export async function getPageDetail(
  connection: WordpressConnectionRecord,
  slug: string,
  env?: WordpressEnv,
  plugins?: string[] | null,
): Promise<WordpressPageDetailDto> {
  const site = resolveEnvironment(connection, env)
  const resolvedPlugins = plugins === undefined
    ? await listActivePlugins(connection, site.env)
    : plugins
  const page = await getPageBySlug(connection, slug, site.env)
  const html = await fetchRenderedPage(page.link)
  const schemaBlocks = html ? extractSchemaBlocks(html) : []
  const seo = buildSeoState(page, html, resolvedPlugins)

  return {
    id: page.id,
    slug: page.slug,
    title: stripHtml(page.title?.rendered ?? ''),
    status: page.status,
    modifiedAt: page.modified ?? page.modified_gmt ?? null,
    link: page.link ?? null,
    env: site.env,
    content: page.content?.raw ?? page.content?.rendered ?? '',
    seo,
    schemaBlocks,
  }
}

export async function createPage(
  connection: WordpressConnectionRecord,
  body: { title: string; slug: string; content: string; status?: string },
  env?: WordpressEnv,
): Promise<WordpressPageDetailDto> {
  const site = resolveEnvironment(connection, env)
  const { body: created } = await fetchJson<WordpressRestPage>(
    connection,
    site.siteUrl,
    '/wp-json/wp/v2/pages',
    {
      method: 'POST',
      body: JSON.stringify({
        title: body.title,
        slug: body.slug,
        content: body.content,
        status: body.status ?? 'draft',
      }),
    },
  )

  return getPageDetail(connection, created.slug, site.env)
}

export async function updatePageBySlug(
  connection: WordpressConnectionRecord,
  slug: string,
  body: { title?: string; slug?: string; content?: string; status?: string },
  env?: WordpressEnv,
): Promise<WordpressPageDetailDto> {
  const site = resolveEnvironment(connection, env)
  const page = await getPageBySlug(connection, slug, site.env)
  const { body: updated } = await fetchJson<WordpressRestPage>(
    connection,
    site.siteUrl,
    `/wp-json/wp/v2/pages/${page.id}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  )

  return getPageDetail(connection, updated.slug, site.env)
}

function encodeNoindexValue(key: string, value: boolean): unknown {
  if (key === 'rank_math_robots') {
    return value ? ['noindex'] : ['index']
  }
  return value ? '1' : '0'
}

export async function setSeoMeta(
  connection: WordpressConnectionRecord,
  slug: string,
  body: { title?: string; description?: string; noindex?: boolean },
  env?: WordpressEnv,
): Promise<WordpressPageDetailDto> {
  const site = resolveEnvironment(connection, env)
  const plugins = await listActivePlugins(connection, site.env)
  const page = await getPageBySlug(connection, slug, site.env)
  const writeTargets = resolveSeoWriteTargets(page.meta, plugins)
  if (writeTargets.length === 0 || !page.meta) {
    throw new WordpressApiError('UNSUPPORTED', 'This WordPress site does not expose writable SEO meta fields through REST. Update the meta manually in WordPress.', 400)
  }

  const patch: Record<string, unknown> = {}
  for (const target of SEO_TARGETS) {
    if (body.title != null && writeTargets.includes(target.titleKey)) patch[target.titleKey] = body.title
    if (body.description != null && writeTargets.includes(target.descriptionKey)) patch[target.descriptionKey] = body.description
    if (body.noindex != null && writeTargets.includes(target.noindexKey)) {
      patch[target.noindexKey] = encodeNoindexValue(target.noindexKey, body.noindex)
    }
  }

  if (Object.keys(patch).length === 0) {
    throw new WordpressApiError('UNSUPPORTED', 'No writable REST-exposed SEO fields matched the requested update.', 400)
  }

  await fetchJson<WordpressRestPage>(
    connection,
    site.siteUrl,
    `/wp-json/wp/v2/pages/${page.id}`,
    {
      method: 'POST',
      body: JSON.stringify({
        meta: {
          ...(page.meta ?? {}),
          ...patch,
        },
      }),
    },
  )

  return getPageDetail(connection, slug, site.env, plugins)
}

export type SeoWriteStrategy = { strategy: 'plugin' | 'manual'; plugins: string[] | null }

export async function detectSeoWriteStrategy(
  connection: WordpressConnectionRecord,
  env?: WordpressEnv,
): Promise<SeoWriteStrategy> {
  const site = resolveEnvironment(connection, env)
  const plugins = await listActivePlugins(connection, site.env)
  const pages = await listPages(connection, site.env)
  if (pages.length === 0) {
    return { strategy: 'manual', plugins }
  }

  const samplePage = await getPageBySlug(connection, pages[0]!.slug, site.env)
  const writeTargets = resolveSeoWriteTargets(samplePage.meta, plugins)
  return {
    strategy: writeTargets.length > 0 ? 'plugin' : 'manual',
    plugins,
  }
}

function buildManualMetaAssist(
  siteUrl: string,
  slug: string,
  link: string | null | undefined,
  meta: { title?: string; description?: string; noindex?: boolean },
): WordpressManualAssistDto {
  const fields: string[] = []
  if (meta.title != null) fields.push(`Title: ${meta.title}`)
  if (meta.description != null) fields.push(`Description: ${meta.description}`)
  if (meta.noindex != null) fields.push(`Noindex: ${meta.noindex}`)
  return {
    manualRequired: true,
    targetUrl: link ?? `${siteUrl}/${slug}`,
    adminUrl: `${siteUrl}/wp-admin/`,
    content: fields.join('\n'),
    nextSteps: [
      `Open the WordPress editor for page "${slug}".`,
      'Install an SEO plugin (Yoast SEO, Rank Math, or AIOSEO) to manage meta fields via REST, or set the values manually in the page editor.',
      'Apply the meta values listed above.',
      'Publish/update the page.',
    ],
  }
}

export interface BulkMetaEntry {
  slug: string
  title?: string
  description?: string
  noindex?: boolean
}

export async function bulkSetSeoMeta(
  connection: WordpressConnectionRecord,
  entries: BulkMetaEntry[],
  env?: WordpressEnv,
): Promise<WordpressBulkMetaResultDto> {
  const site = resolveEnvironment(connection, env)
  const { strategy, plugins } = await detectSeoWriteStrategy(connection, site.env)

  const results = await mapWithConcurrency<BulkMetaEntry, WordpressBulkMetaEntryResultDto>(
    entries,
    3,
    async (entry) => {
      try {
        const page = await getPageBySlug(connection, entry.slug, site.env)

        if (strategy === 'manual') {
          return {
            slug: entry.slug,
            status: 'manual',
            manualAssist: buildManualMetaAssist(
              site.siteUrl,
              entry.slug,
              page.link,
              entry,
            ),
          }
        }

        const writeTargets = resolveSeoWriteTargets(page.meta, plugins)
        if (writeTargets.length === 0 || !page.meta) {
          return {
            slug: entry.slug,
            status: 'manual',
            manualAssist: buildManualMetaAssist(
              site.siteUrl,
              entry.slug,
              page.link,
              entry,
            ),
          }
        }

        const patch: Record<string, unknown> = {}
        for (const target of SEO_TARGETS) {
          if (entry.title != null && writeTargets.includes(target.titleKey)) patch[target.titleKey] = entry.title
          if (entry.description != null && writeTargets.includes(target.descriptionKey)) patch[target.descriptionKey] = entry.description
          if (entry.noindex != null && writeTargets.includes(target.noindexKey)) {
            patch[target.noindexKey] = encodeNoindexValue(target.noindexKey, entry.noindex)
          }
        }

        if (Object.keys(patch).length === 0) {
          return {
            slug: entry.slug,
            status: 'manual',
            manualAssist: buildManualMetaAssist(
              site.siteUrl,
              entry.slug,
              page.link,
              entry,
            ),
          }
        }

        await fetchJson<WordpressRestPage>(
          connection,
          site.siteUrl,
          `/wp-json/wp/v2/pages/${page.id}`,
          {
            method: 'POST',
            body: JSON.stringify({
              meta: { ...(page.meta ?? {}), ...patch },
            }),
          },
        )

        return { slug: entry.slug, status: 'applied' }
      } catch (error) {
        if (error instanceof WordpressApiError && error.code === 'NOT_FOUND') {
          return { slug: entry.slug, status: 'skipped', error: `Page "${entry.slug}" not found` }
        }
        return {
          slug: entry.slug,
          status: 'skipped',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  )

  return { env: site.env, strategy, results }
}

const CANONRY_SCHEMA_START = '<!-- canonry:schema:start -->'
const CANONRY_SCHEMA_END = '<!-- canonry:schema:end -->'

export function stripCanonrySchema(content: string): string {
  const regex = new RegExp(
    `${escapeRegExp(CANONRY_SCHEMA_START)}[\\s\\S]*?${escapeRegExp(CANONRY_SCHEMA_END)}`,
    'g',
  )
  return content.replace(regex, '').replace(/\n{3,}/g, '\n\n').trim()
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function injectCanonrySchema(content: string, schemas: Record<string, unknown>[]): string {
  if (schemas.length === 0) return content
  const blocks = schemas
    .map((schema) => `<script type="application/ld+json">${JSON.stringify(schema).replace(/<\//g, '<\\/')}</script>`)
    .join('\n')
  const injection = `\n\n${CANONRY_SCHEMA_START}\n${blocks}\n${CANONRY_SCHEMA_END}`
  const stripped = stripCanonrySchema(content)
  return stripped + injection
}

async function verifySchemaInjection(
  connection: WordpressConnectionRecord,
  slug: string,
  env: WordpressEnv,
): Promise<boolean> {
  const page = await getPageBySlug(connection, slug, env)
  const raw = page.content?.raw ?? page.content?.rendered ?? ''
  return raw.includes(CANONRY_SCHEMA_START)
}

export async function deploySchema(
  connection: WordpressConnectionRecord,
  slug: string,
  schemas: Record<string, unknown>[],
  env?: WordpressEnv,
): Promise<WordpressSchemaDeployEntryResultDto> {
  const site = resolveEnvironment(connection, env)
  try {
    const page = await getPageBySlug(connection, slug, site.env)
    const currentContent = page.content?.raw ?? page.content?.rendered ?? ''
    const updatedContent = injectCanonrySchema(currentContent, schemas)

    await fetchJson<WordpressRestPage>(
      connection,
      site.siteUrl,
      `/wp-json/wp/v2/pages/${page.id}`,
      {
        method: 'POST',
        body: JSON.stringify({ content: updatedContent }),
      },
    )

    const persisted = await verifySchemaInjection(connection, slug, site.env)
    if (!persisted) {
      return {
        slug,
        status: 'stripped',
        schemasInjected: schemas.map((s) => String(s['@type'] ?? 'Unknown')),
        manualAssist: {
          manualRequired: true,
          targetUrl: page.link ?? `${site.siteUrl}/${slug}`,
          adminUrl: `${site.siteUrl}/wp-admin/`,
          content: schemas.map((s) => JSON.stringify(s, null, 2)).join('\n\n'),
          nextSteps: [
            `WordPress stripped the schema <script> tags for page "${slug}". The connected user likely lacks the unfiltered_html capability.`,
            'Grant the user Administrator or Super Admin role, or add the schema manually in the page editor or via a schema plugin.',
            'Paste the JSON-LD blocks provided above.',
          ],
        },
      }
    }

    return {
      slug,
      status: 'deployed',
      schemasInjected: schemas.map((s) => String(s['@type'] ?? 'Unknown')),
    }
  } catch (error) {
    if (error instanceof WordpressApiError && error.code === 'NOT_FOUND') {
      return { slug, status: 'skipped', error: `Page "${slug}" not found` }
    }
    return {
      slug,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function deploySchemaFromProfile(
  connection: WordpressConnectionRecord,
  profile: SchemaProfileFile,
  env?: WordpressEnv,
): Promise<WordpressSchemaDeployResultDto> {
  const site = resolveEnvironment(connection, env)

  const slugEntries = Object.entries(profile.pages)
  const results = await mapWithConcurrency<
    [string, SchemaPageEntry[]],
    WordpressSchemaDeployEntryResultDto
  >(
    slugEntries,
    3,
    async ([slug, entries]) => {
      const parsed = entries.map(parseSchemaPageEntry)
      const unsupported = parsed.filter((p) => !isSupportedSchemaType(p.type))
      if (unsupported.length > 0) {
        return {
          slug,
          status: 'failed',
          error: `Unsupported schema type(s): ${unsupported.map((u) => u.type).join(', ')}`,
        }
      }

      const schemas = parsed.map((p) => generateSchema(p.type, profile.business, { faqs: p.faqs }))
      return deploySchema(connection, slug, schemas, site.env)
    },
  )

  return { env: site.env, results }
}

export async function getSchemaStatus(
  connection: WordpressConnectionRecord,
  env?: WordpressEnv,
): Promise<WordpressSchemaStatusResultDto> {
  const site = resolveEnvironment(connection, env)
  const pages = await listPages(connection, site.env)
  const details = await mapWithConcurrency(
    pages,
    5,
    async (page) => getPageDetail(connection, page.slug, site.env),
  )

  const statusPages: WordpressSchemaStatusPageDto[] = details.map((page) => {
    const rawContent = page.content
    const hasCanonryMarker = rawContent.includes(CANONRY_SCHEMA_START)

    const allSchemaTypes = page.schemaBlocks.map((b) => b.type)
    const canonrySchemas: string[] = []
    const thirdPartySchemas: string[] = []

    if (hasCanonryMarker) {
      const markerRegex = new RegExp(
        `${escapeRegExp(CANONRY_SCHEMA_START)}([\\s\\S]*?)${escapeRegExp(CANONRY_SCHEMA_END)}`,
      )
      const match = markerRegex.exec(rawContent)
      if (match?.[1]) {
        const jsonLdRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
        let jsonMatch: RegExpExecArray | null
        while ((jsonMatch = jsonLdRegex.exec(match[1])) !== null) {
          try {
            const parsed = JSON.parse(jsonMatch[1]!.trim()) as Record<string, unknown>
            canonrySchemas.push(String(parsed['@type'] ?? 'Unknown'))
          } catch {
            // ignore
          }
        }
      }
    }

    // Count-based subtraction: each canonry schema type accounts for one
    // occurrence in allSchemaTypes; remaining occurrences are third-party
    const canonryCounts = new Map<string, number>()
    for (const t of canonrySchemas) {
      canonryCounts.set(t, (canonryCounts.get(t) ?? 0) + 1)
    }
    for (const schemaType of allSchemaTypes) {
      const remaining = canonryCounts.get(schemaType) ?? 0
      if (remaining > 0) {
        canonryCounts.set(schemaType, remaining - 1)
      } else {
        thirdPartySchemas.push(schemaType)
      }
    }

    return {
      slug: page.slug,
      title: page.title,
      canonrySchemas,
      thirdPartySchemas,
      hasCanonrySchema: hasCanonryMarker,
    }
  })

  return { env: site.env, pages: statusPages }
}

export async function getLlmsTxt(
  connection: WordpressConnectionRecord,
  env?: WordpressEnv,
): Promise<{ env: WordpressEnv; url: string; content: string | null }> {
  const site = resolveEnvironment(connection, env)
  const url = `${site.siteUrl}/llms.txt`
  return {
    env: site.env,
    url,
    content: await fetchText(url),
  }
}

export async function buildManualLlmsTxtUpdate(
  connection: WordpressConnectionRecord,
  content: string,
  env?: WordpressEnv,
): Promise<WordpressManualAssistDto> {
  const site = resolveEnvironment(connection, env)
  return {
    manualRequired: true,
    targetUrl: `${site.siteUrl}/llms.txt`,
    adminUrl: `${site.siteUrl}/wp-admin/`,
    content,
    nextSteps: [
      `Open your hosting file manager or SSH session for ${site.siteUrl}.`,
      'Create or update the file llms.txt at the site root.',
      'Paste the generated content exactly as provided.',
      'Reload /llms.txt in a browser to confirm the file is publicly reachable.',
    ],
  }
}

export async function getPageSchema(
  connection: WordpressConnectionRecord,
  slug: string,
  env?: WordpressEnv,
): Promise<{ env: WordpressEnv; slug: string; blocks: WordpressSchemaBlockDto[] }> {
  const detail = await getPageDetail(connection, slug, env)
  return {
    env: detail.env,
    slug: detail.slug,
    blocks: detail.schemaBlocks,
  }
}

export async function buildManualSchemaUpdate(
  connection: WordpressConnectionRecord,
  slug: string,
  body: { type?: string; json: string },
  env?: WordpressEnv,
): Promise<WordpressManualAssistDto> {
  const site = resolveEnvironment(connection, env)
  const page = await getPageBySlug(connection, slug, site.env)
  return {
    manualRequired: true,
    targetUrl: page.link ?? `${site.siteUrl}/${slug}`,
    adminUrl: `${site.siteUrl}/wp-admin/`,
    content: body.json,
    nextSteps: [
      `Open the WordPress editor or theme/plugin settings for ${page.slug}.`,
      `Add the ${body.type ?? 'custom'} JSON-LD block to the page or the site-level schema tool you use.`,
      'Publish/update the page and refresh the public URL to confirm the JSON-LD block is rendered.',
    ],
  }
}

export async function runAudit(
  connection: WordpressConnectionRecord,
  env?: WordpressEnv,
): Promise<{ env: WordpressEnv; pages: WordpressAuditPageDto[]; issues: WordpressAuditIssueDto[] }> {
  const site = resolveEnvironment(connection, env)
  const pages = await listPages(connection, site.env)
  const plugins = await listActivePlugins(connection, site.env)
  const details = await mapWithConcurrency(
    pages,
    5,
    async (page) => getPageDetail(connection, page.slug, site.env, plugins),
  )

  const auditPages: WordpressAuditPageDto[] = []
  const allIssues: WordpressAuditIssueDto[] = []

  for (const page of details) {
    const issues: WordpressAuditIssueDto[] = []
    const wordCount = computeWordCount(page.content)
    const schemaPresent = page.schemaBlocks.length > 0

    if (page.status === 'publish' && page.seo.noindex === true) {
      issues.push({
        slug: page.slug,
        severity: 'high',
        code: 'noindex',
        message: 'Published page is marked noindex.',
      })
    }
    if (!page.seo.title) {
      issues.push({
        slug: page.slug,
        severity: 'medium',
        code: 'missing-seo-title',
        message: 'Rendered page title is missing.',
      })
    }
    if (!page.seo.description) {
      issues.push({
        slug: page.slug,
        severity: 'medium',
        code: 'missing-meta-description',
        message: 'Rendered meta description is missing.',
      })
    }
    if (!schemaPresent) {
      issues.push({
        slug: page.slug,
        severity: 'medium',
        code: 'missing-schema',
        message: 'No JSON-LD schema was detected on the rendered page.',
      })
    }
    if (wordCount < THIN_CONTENT_WORD_COUNT) {
      issues.push({
        slug: page.slug,
        severity: 'low',
        code: 'thin-content',
        message: `Page content is thin (${wordCount} words; target at least ${THIN_CONTENT_WORD_COUNT}).`,
      })
    }

    auditPages.push({
      slug: page.slug,
      title: page.title,
      status: page.status,
      wordCount,
      seo: page.seo,
      schemaPresent,
      issues,
    })
    allIssues.push(...issues)
  }

  const severityWeight = { high: 0, medium: 1, low: 2 } as const
  allIssues.sort((a: WordpressAuditIssueDto, b: WordpressAuditIssueDto) => {
    return severityWeight[a.severity] - severityWeight[b.severity] || a.slug.localeCompare(b.slug)
  })

  return {
    env: site.env,
    pages: auditPages,
    issues: allIssues,
  }
}

export async function diffPageAcrossEnvironments(
  connection: WordpressConnectionRecord,
  slug: string,
): Promise<WordpressDiffDto> {
  if (!connection.stagingUrl) {
    throw new WordpressApiError('VALIDATION_ERROR', 'No staging URL configured for this project. Reconnect with --staging-url before using diff.', 400)
  }

  const [livePlugins, stagingPlugins] = await Promise.all([
    listActivePlugins(connection, 'live'),
    listActivePlugins(connection, 'staging'),
  ])
  const live = await getPageDetail(connection, slug, 'live', livePlugins)
  const staging = await getPageDetail(connection, slug, 'staging', stagingPlugins)
  const liveContentHash = contentHash(live.content)
  const stagingContentHash = contentHash(staging.content)
  const liveDiff: WordpressDiffPageDto = {
    ...live,
    contentHash: liveContentHash,
    contentSnippet: buildSnippet(live.content),
  }
  const stagingDiff: WordpressDiffPageDto = {
    ...staging,
    contentHash: stagingContentHash,
    contentSnippet: buildSnippet(staging.content),
  }
  const differences = {
    title: live.title !== staging.title,
    slug: live.slug !== staging.slug,
    content: liveContentHash !== stagingContentHash,
    seoTitle: live.seo.title !== staging.seo.title,
    seoDescription: live.seo.description !== staging.seo.description,
    noindex: live.seo.noindex !== staging.seo.noindex,
    schema: JSON.stringify(live.schemaBlocks) !== JSON.stringify(staging.schemaBlocks),
  }

  return {
    slug,
    live: liveDiff,
    staging: stagingDiff,
    hasDifferences: Object.values(differences).some(Boolean),
    differences,
  }
}

export async function buildManualStagingPush(
  connection: WordpressConnectionRecord,
): Promise<WordpressManualAssistDto> {
  const liveStatus = await getSiteStatus(connection, 'live')
  const plugins = liveStatus.plugins ?? []
  const wpStagingActive = plugins.some((plugin: string) => plugin.includes('wp-staging'))
  return {
    manualRequired: true,
    targetUrl: getWpStagingAdminUrl(connection.url),
    adminUrl: getWpStagingAdminUrl(connection.url),
    content: JSON.stringify({
      liveUrl: connection.url,
      stagingUrl: connection.stagingUrl ?? null,
      wpStagingActive,
    }, null, 2),
    nextSteps: [
      'Open the WP STAGING admin page on the live site.',
      wpStagingActive
        ? 'Review the staging site snapshot you want to push and use the plugin UI to start the push-to-live workflow.'
        : 'Confirm the WP STAGING plugin is installed and active before attempting a push-to-live operation.',
      'Complete the plugin confirmation steps in wp-admin and verify the live site after the push finishes.',
    ],
  }
}

export function parseEnv(value: unknown): WordpressEnv | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = wordpressEnvSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
