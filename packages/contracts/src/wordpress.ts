import { z } from 'zod'

export const wordpressEnvSchema = z.enum(['live', 'staging'])
export type WordpressEnv = z.infer<typeof wordpressEnvSchema>

export const wordpressConnectionDtoSchema = z.object({
  projectName: z.string(),
  url: z.string(),
  stagingUrl: z.string().optional(),
  username: z.string(),
  defaultEnv: wordpressEnvSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type WordpressConnectionDto = z.infer<typeof wordpressConnectionDtoSchema>

export const wordpressSiteStatusDtoSchema = z.object({
  url: z.string(),
  reachable: z.boolean(),
  pageCount: z.number().nullable().optional(),
  version: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  plugins: z.array(z.string()).optional(),
  authenticatedUser: z.object({
    id: z.number(),
    slug: z.string(),
  }).nullable().optional(),
})
export type WordpressSiteStatusDto = z.infer<typeof wordpressSiteStatusDtoSchema>

export const wordpressStatusDtoSchema = z.object({
  connected: z.boolean(),
  projectName: z.string(),
  defaultEnv: wordpressEnvSchema,
  live: wordpressSiteStatusDtoSchema.nullable(),
  staging: wordpressSiteStatusDtoSchema.nullable(),
  adminUrl: z.string().nullable().optional(),
})
export type WordpressStatusDto = z.infer<typeof wordpressStatusDtoSchema>

export const wordpressPageSummaryDtoSchema = z.object({
  id: z.number(),
  slug: z.string(),
  title: z.string(),
  status: z.string(),
  modifiedAt: z.string().nullable().optional(),
  link: z.string().nullable().optional(),
})
export type WordpressPageSummaryDto = z.infer<typeof wordpressPageSummaryDtoSchema>

export const wordpressSeoStateDtoSchema = z.object({
  title: z.string().nullable(),
  description: z.string().nullable(),
  noindex: z.boolean().nullable(),
  writable: z.boolean().default(false),
  writeTargets: z.array(z.string()).default([]),
})
export type WordpressSeoStateDto = z.infer<typeof wordpressSeoStateDtoSchema>

export const wordpressSchemaBlockDtoSchema = z.object({
  type: z.string(),
  json: z.record(z.string(), z.unknown()),
})
export type WordpressSchemaBlockDto = z.infer<typeof wordpressSchemaBlockDtoSchema>

export const wordpressPageDetailDtoSchema = wordpressPageSummaryDtoSchema.extend({
  env: wordpressEnvSchema,
  content: z.string(),
  seo: wordpressSeoStateDtoSchema,
  schemaBlocks: z.array(wordpressSchemaBlockDtoSchema).default([]),
})
export type WordpressPageDetailDto = z.infer<typeof wordpressPageDetailDtoSchema>

export const wordpressDiffPageDtoSchema = wordpressPageDetailDtoSchema.extend({
  contentHash: z.string(),
  contentSnippet: z.string(),
})
export type WordpressDiffPageDto = z.infer<typeof wordpressDiffPageDtoSchema>

export const wordpressManualAssistDtoSchema = z.object({
  manualRequired: z.literal(true),
  targetUrl: z.string(),
  adminUrl: z.string().nullable().optional(),
  content: z.string(),
  nextSteps: z.array(z.string()).default([]),
})
export type WordpressManualAssistDto = z.infer<typeof wordpressManualAssistDtoSchema>

export const wordpressAuditIssueDtoSchema = z.object({
  slug: z.string(),
  severity: z.enum(['high', 'medium', 'low']),
  code: z.enum([
    'noindex',
    'missing-seo-title',
    'missing-meta-description',
    'missing-schema',
    'thin-content',
  ]),
  message: z.string(),
})
export type WordpressAuditIssueDto = z.infer<typeof wordpressAuditIssueDtoSchema>

export const wordpressAuditPageDtoSchema = z.object({
  slug: z.string(),
  title: z.string(),
  status: z.string(),
  wordCount: z.number(),
  seo: wordpressSeoStateDtoSchema,
  schemaPresent: z.boolean(),
  issues: z.array(wordpressAuditIssueDtoSchema).default([]),
})
export type WordpressAuditPageDto = z.infer<typeof wordpressAuditPageDtoSchema>

export const wordpressDiffDtoSchema = z.object({
  slug: z.string(),
  live: wordpressDiffPageDtoSchema,
  staging: wordpressDiffPageDtoSchema,
  hasDifferences: z.boolean(),
  differences: z.object({
    title: z.boolean(),
    slug: z.boolean(),
    content: z.boolean(),
    seoTitle: z.boolean(),
    seoDescription: z.boolean(),
    noindex: z.boolean(),
    schema: z.boolean(),
  }),
})
export type WordpressDiffDto = z.infer<typeof wordpressDiffDtoSchema>
