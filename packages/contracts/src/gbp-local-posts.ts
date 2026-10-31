import { z } from 'zod'

export const GBP_POSTS_WRITE_SCOPE = 'gbp.posts.write'
export const GBP_LIVE_READ_SCOPE = 'gbp.read'
export const gbpAccountNameSchema = z
  .string()
  .regex(/^accounts\/[1-9]\d{0,29}$/u)
export const gbpLocationNameSchema = z
  .string()
  .regex(/^locations\/[1-9]\d{0,29}$/u)
export const gbpLocalPostNameSchema = z
  .string()
  .regex(
    /^accounts\/[1-9]\d{0,29}\/locations\/[1-9]\d{0,29}\/localPosts\/[\w-]{1,200}$/u,
  )
const publicUrl = z.url().refine((value) => {
  const url = new URL(value)
  return (
    url.protocol === 'https:' && !url.username && !url.password && !url.hash
  )
}, 'An HTTPS URL without credentials or fragment is required')
export const gbpLocalPostStateSchema = z.enum([
  'LIVE',
  'PROCESSING',
  'REJECTED',
  'SCHEDULED',
  'RECURRING',
  'LOCAL_POST_STATE_UNSPECIFIED',
])
export const GbpLocalPostStates = Object.freeze(gbpLocalPostStateSchema.enum)
export const gbpLocalPostContentSchema = z
  .object({
    languageCode: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/u),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(1500)
      .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value.replace(/\n/gu, ''))),
    topicType: z.literal('STANDARD'),
    callToAction: z
      .object({ actionType: z.literal('LEARN_MORE'), url: publicUrl })
      .strict(),
    media: z.tuple([
      z
        .object({ mediaFormat: z.literal('PHOTO'), sourceUrl: publicUrl })
        .strict(),
    ]),
  })
  .strict()
export type GbpLocalPostContent = z.infer<typeof gbpLocalPostContentSchema>
export const gbpLocalPostDtoSchema = z.object({
  name: gbpLocalPostNameSchema,
  languageCode: z.string(),
  summary: z.string(),
  topicType: z.string(),
  state: gbpLocalPostStateSchema,
  actionType: z.string().nullable(),
  articleUrl: z.string().nullable(),
  imageUrls: z.array(z.string()),
  /** Provider-hosted pixels from the exact resource; never a source-identity assertion. */
  providerImageUrls: z.array(publicUrl).optional(),
  /** False means callers must independently compare the returned provider image. */
  mediaSourceUrlsComplete: z.boolean().optional(),
  createTime: z.string().datetime({ offset: true }),
  updateTime: z.string().datetime({ offset: true }),
  searchUrl: z.string().nullable(),
})
export type GbpLocalPostDto = z.infer<typeof gbpLocalPostDtoSchema>
export const gbpLocalPostListSchema = z.object({
  posts: z.array(gbpLocalPostDtoSchema),
  nextPageToken: z.string().nullable(),
})
export type GbpLocalPostList = z.infer<typeof gbpLocalPostListSchema>
export const gbpLocalPostCreateSchema = z
  .object({
    accountName: gbpAccountNameSchema,
    locationName: gbpLocationNameSchema,
    attemptId: z.string().uuid(),
    packageId: z.string().regex(/^[a-f0-9]{64}$/u),
    content: gbpLocalPostContentSchema,
  })
  .strict()
export type GbpLocalPostCreate = z.infer<typeof gbpLocalPostCreateSchema>
export const gbpLocalPostAttemptSchema = z.object({
  attemptId: z.string().uuid(),
  packageId: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(['accepted', 'uncertain', 'rejected']),
  post: gbpLocalPostDtoSchema.nullable(),
})
export type GbpLocalPostAttempt = z.infer<typeof gbpLocalPostAttemptSchema>
export const gbpLiveReviewsSchema = z.object({
  accountName: gbpAccountNameSchema,
  locationName: gbpLocationNameSchema,
  profileUrl: publicUrl.nullable(),
  checkedAt: z.string().datetime(),
  complete: z.literal(true),
  reviews: z.array(
    z.object({
      reviewName: z.string(),
      starRating: z.number().int().min(1).max(5).nullable(),
      comment: z.string().nullable(),
      reviewerName: z.string().nullable(),
      createTime: z.string().nullable(),
      updateTime: z.string(),
    }),
  ),
})
export type GbpLiveReviews = z.infer<typeof gbpLiveReviewsSchema>
