import { z } from 'zod'
import {
  sentimentBackfillPreviewSchema, sentimentComparisonSchema, sentimentCountsSchema, sentimentEvidencePageSchema,
  sentimentJobSchema, sentimentJobsSchema, sentimentSettingsSchema, sentimentSummarySchema,
  type SentimentBackfillPreview, type SentimentComparison, type SentimentEvidencePage, type SentimentJob,
  type SentimentSettings, type SentimentSummary,
} from './sentiment.js'
import { tolerantReadSchema, type TolerantRead, type TolerantReadOptions } from './tolerant-read.js'

/**
 * Client-side readers for the sentiment responses, for the CLI and the MCP
 * adapter. The DTOs in `sentiment.ts` stay strict on the server. A reader
 * drops keys it does not know, reads outcomes, states and other closed values
 * as plain strings, and keeps a count keyed by an outcome it does not know,
 * so a response from a newer server is never rejected for a field, value or
 * outcome this build predates.
 */
const OPEN_COUNTS: TolerantReadOptions = { openKeys: [[sentimentCountsSchema, z.number().int().nonnegative()]] }

export const sentimentSettingsReadSchema = tolerantReadSchema(sentimentSettingsSchema, OPEN_COUNTS)
export type SentimentSettingsRead = TolerantRead<SentimentSettings>
export const sentimentSummaryReadSchema = tolerantReadSchema(sentimentSummarySchema, OPEN_COUNTS)
export type SentimentSummaryRead = TolerantRead<SentimentSummary>
export const sentimentEvidencePageReadSchema = tolerantReadSchema(sentimentEvidencePageSchema, OPEN_COUNTS)
export type SentimentEvidencePageRead = TolerantRead<SentimentEvidencePage>
export const sentimentComparisonReadSchema = tolerantReadSchema(sentimentComparisonSchema, OPEN_COUNTS)
export type SentimentComparisonRead = TolerantRead<SentimentComparison>
export const sentimentBackfillPreviewReadSchema = tolerantReadSchema(sentimentBackfillPreviewSchema, OPEN_COUNTS)
export type SentimentBackfillPreviewRead = TolerantRead<SentimentBackfillPreview>
export const sentimentJobReadSchema = tolerantReadSchema(sentimentJobSchema, OPEN_COUNTS)
export type SentimentJobRead = TolerantRead<SentimentJob>
export const sentimentJobsReadSchema = tolerantReadSchema(sentimentJobsSchema, OPEN_COUNTS)
export type SentimentJobsRead = TolerantRead<z.output<typeof sentimentJobsSchema>>
