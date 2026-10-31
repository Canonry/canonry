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

/** Safe categories only; provider payloads never become diagnostic messages. */
export class GbpLocalPostResponseError extends Error {
  constructor(readonly reason: 'INVALID_RESPONSE' | 'UNSUPPORTED_MEDIA' | 'WRONG_IDENTITY') {
    super(reason === 'UNSUPPORTED_MEDIA'
      ? 'Unsupported or incomplete Google Local Post media'
      : reason === 'WRONG_IDENTITY'
        ? 'Wrong Google Local Post identity'
        : 'Invalid Google Local Post response')
    this.name = 'GbpLocalPostResponseError'
  }
}

function parent(account: string, location: string): string {
  return `${gbpAccountNameSchema.parse(account)}/${gbpLocationNameSchema.parse(location)}`
}
function post(value: unknown, mediaMode: 'exact' | 'discovery' = 'exact'): GbpLocalPostDto {
  if (!value || typeof value !== 'object')
    throw new GbpLocalPostResponseError('INVALID_RESPONSE')
  const raw = value as Record<string, unknown>
  const action = raw.callToAction as Record<string, unknown> | undefined
  if (raw.media !== undefined && !Array.isArray(raw.media))
    throw new GbpLocalPostResponseError('INVALID_RESPONSE')
  const media = (raw.media ?? []) as Array<Record<string, unknown>>
  if (media.some(item => !item || typeof item !== 'object' || Array.isArray(item)))
    throw new GbpLocalPostResponseError('INVALID_RESPONSE')
  const mediaSourceUrlsComplete = media.every(
    item => item.mediaFormat === 'PHOTO' && typeof item.sourceUrl === 'string',
  )
  const providerImageUrls = media.map(item => {
    if (item.mediaFormat !== 'PHOTO' || typeof item.googleUrl !== 'string') return null
    try {
      const url = new URL(item.googleUrl)
      return url.protocol === 'https:' && /^lh\d+\.googleusercontent\.com$/u.test(url.hostname) &&
        !url.username && !url.password && !url.port && !url.hash ? url.href : null
    } catch { return null }
  })
  const providerImagesComplete = providerImageUrls.length > 0 && providerImageUrls.every(url => url !== null)
  // A provider URL identifies pixels to compare, never the approved source image.
  // Older consumers still see no imageUrls and cannot mistakenly verify this form.
  if (!mediaSourceUrlsComplete && !providerImagesComplete && mediaMode === 'exact' && raw.state !== GbpLocalPostStates.REJECTED)
    throw new GbpLocalPostResponseError('UNSUPPORTED_MEDIA')
  const parsed = gbpLocalPostDtoSchema.safeParse({
    name: raw.name,
    languageCode: raw.languageCode ?? '',
    summary: raw.summary ?? '',
    topicType: raw.topicType ?? '',
    state: raw.state ?? GbpLocalPostStates.LOCAL_POST_STATE_UNSPECIFIED,
    actionType: action?.actionType ?? null,
    articleUrl: action?.url ?? null,
    imageUrls: mediaSourceUrlsComplete ? media.map((item) => item.sourceUrl) : [],
    ...(mediaMode === 'discovery' || !mediaSourceUrlsComplete ? { mediaSourceUrlsComplete } : {}),
    ...(providerImagesComplete ? { providerImageUrls } : {}),
    createTime: raw.createTime,
    updateTime: raw.updateTime,
    searchUrl: raw.searchUrl ?? null,
  })
  if (!parsed.success) throw new GbpLocalPostResponseError('INVALID_RESPONSE')
  return parsed.data
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.localPosts !== undefined && !Array.isArray(raw.localPosts)))
    throw new GbpLocalPostResponseError('INVALID_RESPONSE')
  const posts = (raw.localPosts ?? []).map(item => post(item, 'discovery'))
  if (posts.some((item) => !item.name.startsWith(`${scope}/localPosts/`)))
    throw new GbpLocalPostResponseError('WRONG_IDENTITY')
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
  if (result.name !== name) throw new GbpLocalPostResponseError('WRONG_IDENTITY')
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
