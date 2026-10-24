/** Fixed Google v4 endpoints. A create is attempted once; callers persist intent first. */
import {
  gbpAccountNameSchema,
  gbpLocationNameSchema,
  gbpLocalPostNameSchema,
  gbpLocalPostContentSchema,
  gbpLocalPostDtoSchema,
  GbpLocalPostStates,
  type GbpLocalPostContent,
  type GbpLocalPostDto,
  type GbpLocalPostList,
} from '@canonry/canonry-contracts'
import { GBP_LEGACY_V4_BASE, GBP_REQUEST_TIMEOUT_MS } from './constants.js'
import { gbpFetchGet } from './http.js'
import { GbpApiError, type GbpFetchOptions } from './types.js'

function parent(account: string, location: string): string {
  return `${gbpAccountNameSchema.parse(account)}/${gbpLocationNameSchema.parse(location)}`
}
function post(value: unknown): GbpLocalPostDto {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid Google Local Post response')
  const raw = value as Record<string, unknown>
  const action = raw.callToAction as Record<string, unknown> | undefined
  const media = Array.isArray(raw.media)
    ? (raw.media as Array<Record<string, unknown>>)
    : []
  // Never hide additional/unknown attachments from exact visual verification.
  if (
    media.some(
      (item) =>
        !item ||
        item.mediaFormat !== 'PHOTO' ||
        typeof item.sourceUrl !== 'string',
    )
  )
    throw new Error('Unsupported or incomplete Google Local Post media')
  return gbpLocalPostDtoSchema.parse({
    name: raw.name,
    languageCode: raw.languageCode ?? '',
    summary: raw.summary ?? '',
    topicType: raw.topicType ?? '',
    state: raw.state ?? GbpLocalPostStates.LOCAL_POST_STATE_UNSPECIFIED,
    actionType: action?.actionType ?? null,
    articleUrl: action?.url ?? null,
    imageUrls: media.map((item) => item.sourceUrl),
    createTime: raw.createTime,
    updateTime: raw.updateTime,
    searchUrl: raw.searchUrl ?? null,
  })
}
export async function listLocalPosts(
  token: string,
  account: string,
  location: string,
  pageToken?: string,
  options: GbpFetchOptions = {},
): Promise<GbpLocalPostList> {
  const scope = parent(account, location)
  const url = new URL(`${GBP_LEGACY_V4_BASE}/${scope}/localPosts`)
  url.searchParams.set('pageSize', '100')
  if (pageToken) url.searchParams.set('pageToken', pageToken)
  const raw = await gbpFetchGet<{
    localPosts?: unknown[]
    nextPageToken?: string
  }>(url.toString(), token, options)
  const posts = (raw.localPosts ?? []).map(post)
  if (posts.some((item) => !item.name.startsWith(`${scope}/localPosts/`)))
    throw new Error('Wrong Google Local Post location')
  return { posts, nextPageToken: raw.nextPageToken ?? null }
}
export async function getLocalPost(
  token: string,
  name: string,
  options: GbpFetchOptions = {},
): Promise<GbpLocalPostDto> {
  gbpLocalPostNameSchema.parse(name)
  const result = post(
    await gbpFetchGet<unknown>(`${GBP_LEGACY_V4_BASE}/${name}`, token, options),
  )
  if (result.name !== name) throw new Error('Wrong Google Local Post identity')
  return result
}
export async function createLocalPost(
  token: string,
  account: string,
  location: string,
  content: GbpLocalPostContent,
): Promise<GbpLocalPostDto> {
  const scope = parent(account, location)
  const payload = gbpLocalPostContentSchema.parse(content)
  // Deliberately no withRetry, including 429/503 or a lost successful response.
  const response = await fetch(`${GBP_LEGACY_V4_BASE}/${scope}/localPosts`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(GBP_REQUEST_TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok)
    throw new GbpApiError(
      'Google Local Post create failed',
      response.status,
      null,
      null,
    )
  const result = post(await response.json())
  if (!result.name.startsWith(`${scope}/localPosts/`))
    throw new Error('Wrong Google Local Post location')
  return result
}
