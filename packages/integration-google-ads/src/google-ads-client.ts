import {
  describeError,
  isRetryableHttpError,
  mapWithConcurrency,
  retryAfterDelayMs,
  withRetry,
  escapeRegExp,
} from '@ainyc/canonry-contracts'
import {
  GOOGLE_ADS_API_BASE,
  GOOGLE_ADS_API_VERSION,
  GOOGLE_ADS_CUSTOMER_DETAIL_CONCURRENCY,
  GOOGLE_ADS_DEFAULT_ACCESSIBLE_CUSTOMER_DETAILS,
  GOOGLE_ADS_MAX_ACCESSIBLE_CUSTOMER_DETAILS,
  GOOGLE_ADS_MAX_RESULT_ROWS,
  GOOGLE_ADS_MAX_RETRIES,
  GOOGLE_ADS_REQUEST_TIMEOUT_MS,
  GOOGLE_ADS_RETRY_BASE_DELAY_MS,
  GOOGLE_ADS_RETRY_MAX_DELAY_MS,
} from './constants.js'
import {
  buildCampaignConversionGoalsQuery,
  buildCampaignSpendRankingQuery,
  buildCampaignsQuery,
  buildConversionActionsQuery,
  buildConversionGoalCampaignConfigsQuery,
  buildCustomConversionGoalsQuery,
  buildCustomerClientsQuery,
  buildCustomerConversionGoalsQuery,
  buildCustomerDetailsQuery,
  buildDailyCampaignMetricsQuery,
  buildDailyConversionMetricsQuery,
  normalizeGoogleAdsCustomerId,
  normalizeGoogleAdsCustomerClientsOptions,
} from './queries.js'
import { GoogleAdsApiError } from './types.js'
import type {
  GoogleAdsAccessibleCustomers,
  GoogleAdsAccessibleCustomerDetailsData,
  GoogleAdsAccessibleCustomerDetailsOptions,
  GoogleAdsCampaignConversionGoalRow,
  GoogleAdsCampaignRow,
  GoogleAdsClientOptions,
  GoogleAdsCompositeResult,
  GoogleAdsConversionActionRow,
  GoogleAdsConversionGoalCampaignConfigRow,
  GoogleAdsConversionGoalData,
  GoogleAdsCredentials,
  GoogleAdsCustomer,
  GoogleAdsCustomerClientRow,
  GoogleAdsCustomerClientsData,
  GoogleAdsCustomerClientsOptions,
  GoogleAdsCustomerConversionGoalRow,
  GoogleAdsCustomerDetailFailure,
  GoogleAdsCustomerRow,
  GoogleAdsCustomConversionGoalRow,
  GoogleAdsDailyCampaignMetricsRow,
  GoogleAdsDailyConversionMetricsRow,
  GoogleAdsDailyMetricsOptions,
  GoogleAdsFetch,
  GoogleAdsListOptions,
  GoogleAdsReadOperation,
  GoogleAdsRequestMetadata,
  GoogleAdsResult,
  GoogleAdsRetryOptions,
} from './types.js'

interface GoogleAdsSearchStreamChunk<T> {
  results?: T[]
  requestId?: string
}

interface ProviderErrorEnvelope {
  error?: {
    message?: unknown
    status?: unknown
    details?: unknown
  }
}

interface CustomerDetailAttempt {
  customer?: GoogleAdsCustomer
  failure?: GoogleAdsCustomerDetailFailure
  metadata?: GoogleAdsRequestMetadata
}

function sanitizeText(value: string, secrets: readonly string[]): string {
  let sanitized = value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,"'}]+/gi, '$1***')
    .replace(/((?:developer|access)[_-]?token\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1***')

  for (const secret of secrets) {
    if (!secret) continue
    sanitized = sanitized.replace(new RegExp(escapeRegExp(secret), 'g'), '***')
    const encoded = encodeURIComponent(secret)
    if (encoded !== secret) {
      sanitized = sanitized.replace(new RegExp(escapeRegExp(encoded), 'g'), '***')
    }
  }

  return sanitized.length <= 1_000 ? sanitized : `${sanitized.slice(0, 1_000)}... [truncated]`
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 256 || /[\r\n]/.test(trimmed)) return undefined
  return trimmed
}

function findRequestId(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRequestId(item, depth + 1)
      if (found) return found
    }
    return undefined
  }

  const record = value as Record<string, unknown>
  const direct = safeRequestId(record.requestId) ?? safeRequestId(record.request_id)
  if (direct) return direct
  for (const nested of Object.values(record)) {
    const found = findRequestId(nested, depth + 1)
    if (found) return found
  }
  return undefined
}

function providerErrorParts(payload: unknown): {
  message?: string
  providerStatus?: string
  requestId?: string
} {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return {}
  const envelope = payload as ProviderErrorEnvelope
  const message = typeof envelope.error?.message === 'string' ? envelope.error.message : undefined
  const providerStatus = typeof envelope.error?.status === 'string' ? envelope.error.status : undefined
  const requestId = findRequestId(envelope.error?.details)
  return { message, providerStatus, requestId }
}

function validateCredential(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GoogleAdsApiError(`${label} is required`, 400)
  }
  return value.trim()
}

function validatedAccessibleCustomerLimit(value: number | undefined): number {
  const limit = value ?? GOOGLE_ADS_DEFAULT_ACCESSIBLE_CUSTOMER_DETAILS
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > GOOGLE_ADS_MAX_ACCESSIBLE_CUSTOMER_DETAILS
  ) {
    throw new GoogleAdsApiError(
      `Accessible customer detail limit must be an integer between 1 and ${GOOGLE_ADS_MAX_ACCESSIBLE_CUSTOMER_DETAILS}`,
      400,
    )
  }
  return limit
}

function customerIdFromResourceName(resourceName: string): string {
  const match = /^customers\/(\d{10})$/.exec(resourceName)
  if (!match) {
    throw new GoogleAdsApiError(
      'Google Ads API returned an invalid accessible customer resource name',
      502,
    )
  }
  return match[1]!
}

function isCustomerClientRow(
  row: Partial<GoogleAdsCustomerClientRow>,
): row is GoogleAdsCustomerClientRow {
  return row.customerClient !== undefined
}

export class GoogleAdsClient {
  readonly #accessToken: string
  readonly #developerToken: string
  readonly #loginCustomerId?: string
  readonly #fetch: GoogleAdsFetch
  readonly #requestTimeoutMs: number
  readonly #retry: GoogleAdsRetryOptions

  constructor(credentials: GoogleAdsCredentials, options: GoogleAdsClientOptions = {}) {
    this.#accessToken = validateCredential(credentials.accessToken, 'Access token')
    this.#developerToken = validateCredential(credentials.developerToken, 'Developer token')
    this.#loginCustomerId = credentials.loginCustomerId === undefined
      ? undefined
      : normalizeGoogleAdsCustomerId(credentials.loginCustomerId, 'Login customer ID')
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#requestTimeoutMs = options.requestTimeoutMs ?? GOOGLE_ADS_REQUEST_TIMEOUT_MS
    if (!Number.isInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1) {
      throw new GoogleAdsApiError('Request timeout must be a positive integer in milliseconds', 400)
    }
    this.#retry = options.retry ?? {}
  }

  async listAccessibleCustomers(): Promise<GoogleAdsResult<GoogleAdsAccessibleCustomers>> {
    const result = await this.#requestJson<Partial<GoogleAdsAccessibleCustomers>>(
      'list-accessible-customers',
      '/customers:listAccessibleCustomers',
      { method: 'GET' },
      false,
    )
    const resourceNames = result.data.resourceNames ?? []
    if (!Array.isArray(resourceNames) || resourceNames.some((name) => typeof name !== 'string')) {
      throw new GoogleAdsApiError(
        'Google Ads API returned an invalid accessible-customer response',
        502,
        undefined,
        result.metadata.requestId,
      )
    }
    return { ...result, data: { resourceNames } }
  }

  async getCustomerDetails(
    customerId: string,
  ): Promise<GoogleAdsResult<GoogleAdsCustomer>> {
    const result = await this.#searchStream<Partial<GoogleAdsCustomerRow>>(
      customerId,
      'customer-details',
      buildCustomerDetailsQuery(),
    )
    if (result.data.length !== 1 || !result.data[0]?.customer) {
      throw new GoogleAdsApiError(
        'Google Ads API returned an invalid customer detail response',
        502,
        undefined,
        result.metadata.requestId,
      )
    }
    return { data: result.data[0].customer, metadata: result.metadata }
  }

  async listAccessibleCustomerDetails(
    options: GoogleAdsAccessibleCustomerDetailsOptions = {},
  ): Promise<GoogleAdsCompositeResult<GoogleAdsAccessibleCustomerDetailsData>> {
    const maxCustomers = validatedAccessibleCustomerLimit(options.maxCustomers)
    const accessible = await this.listAccessibleCustomers()
    const resourceNames = accessible.data.resourceNames.slice(0, maxCustomers)
    const attempts = await mapWithConcurrency(
      resourceNames,
      GOOGLE_ADS_CUSTOMER_DETAIL_CONCURRENCY,
      async (resourceName): Promise<CustomerDetailAttempt> => {
        let customerId: string | undefined
        try {
          customerId = customerIdFromResourceName(resourceName)
          const result = await this.getCustomerDetails(customerId)
          return { customer: result.data, metadata: result.metadata }
        } catch (error) {
          const googleAdsError = error instanceof GoogleAdsApiError ? error : undefined
          const detail = describeError(error)
          return {
            failure: {
              resourceName,
              ...(customerId ? { customerId } : {}),
              ...(googleAdsError?.status !== undefined
                ? { status: googleAdsError.status }
                : {}),
              ...(googleAdsError?.providerStatus
                ? { providerStatus: googleAdsError.providerStatus }
                : {}),
              ...(googleAdsError?.requestId ? { requestId: googleAdsError.requestId } : {}),
              message: sanitizeText(detail, this.#secrets()),
            },
            ...(customerId
              ? {
                  metadata: {
                    apiVersion: GOOGLE_ADS_API_VERSION,
                    operation: 'customer-details',
                    ...(googleAdsError?.requestId
                      ? { requestId: googleAdsError.requestId }
                      : {}),
                  },
                }
              : {}),
          }
        }
      },
    )

    const customers = attempts.flatMap(attempt => attempt.customer ? [attempt.customer] : [])
    const failures = attempts.flatMap(attempt => attempt.failure ? [attempt.failure] : [])
    const omitted = accessible.data.resourceNames.length - resourceNames.length
    return {
      data: {
        customers,
        failures,
        totalAccessible: accessible.data.resourceNames.length,
        attempted: resourceNames.length,
        returned: customers.length,
        truncated: omitted > 0,
        omitted,
      },
      metadata: {
        apiVersion: GOOGLE_ADS_API_VERSION,
        requests: [
          accessible.metadata,
          ...attempts.flatMap(attempt => attempt.metadata ? [attempt.metadata] : []),
        ],
      },
    }
  }

  async getCustomerClients(
    customerId: string,
    options: GoogleAdsCustomerClientsOptions = {},
  ): Promise<GoogleAdsResult<GoogleAdsCustomerClientsData>> {
    const normalizedOptions = normalizeGoogleAdsCustomerClientsOptions(options)
    const result = await this.#searchStream<Partial<GoogleAdsCustomerClientRow>>(
      customerId,
      'customer-clients',
      buildCustomerClientsQuery(normalizedOptions),
    )
    if (!result.data.every(isCustomerClientRow)) {
      throw new GoogleAdsApiError(
        'Google Ads API returned an invalid customer-client response',
        502,
        undefined,
        result.metadata.requestId,
      )
    }
    const truncated = result.data.length > normalizedOptions.maxCustomers
    const customerClients = result.data
      .slice(0, normalizedOptions.maxCustomers)
      .map(row => row.customerClient)
    return {
      data: {
        customerClients,
        maxDepth: normalizedOptions.maxDepth,
        returned: customerClients.length,
        truncated,
      },
      metadata: result.metadata,
    }
  }

  async getCampaigns(
    customerId: string,
    options: GoogleAdsListOptions = {},
  ): Promise<GoogleAdsResult<GoogleAdsCampaignRow[]>> {
    return this.#searchStream(customerId, 'campaigns', buildCampaignsQuery(options))
  }

  async getConversionActions(
    customerId: string,
    options: GoogleAdsListOptions = {},
  ): Promise<GoogleAdsResult<GoogleAdsConversionActionRow[]>> {
    return this.#searchStream(customerId, 'conversion-actions', buildConversionActionsQuery(options))
  }

  async getConversionGoals(
    customerId: string,
  ): Promise<GoogleAdsCompositeResult<GoogleAdsConversionGoalData>> {
    const normalizedCustomerId = normalizeGoogleAdsCustomerId(customerId)
    const [conversionActions, customerGoals, campaignGoals, customGoals, campaignConfigs] =
      await Promise.all([
        this.#searchStream<GoogleAdsConversionActionRow>(
          normalizedCustomerId,
          'conversion-actions',
          buildConversionActionsQuery({ includeRemoved: true }),
        ),
        this.#searchStream<GoogleAdsCustomerConversionGoalRow>(
          normalizedCustomerId,
          'customer-conversion-goals',
          buildCustomerConversionGoalsQuery(),
        ),
        this.#searchStream<GoogleAdsCampaignConversionGoalRow>(
          normalizedCustomerId,
          'campaign-conversion-goals',
          buildCampaignConversionGoalsQuery(),
        ),
        this.#searchStream<GoogleAdsCustomConversionGoalRow>(
          normalizedCustomerId,
          'custom-conversion-goals',
          buildCustomConversionGoalsQuery(),
        ),
        this.#searchStream<GoogleAdsConversionGoalCampaignConfigRow>(
          normalizedCustomerId,
          'conversion-goal-campaign-configs',
          buildConversionGoalCampaignConfigsQuery(),
        ),
      ])

    const raw = {
      conversionActions: conversionActions.data,
      customerGoals: customerGoals.data,
      campaignGoals: campaignGoals.data,
      customGoals: customGoals.data,
      campaignConfigs: campaignConfigs.data,
    }
    return {
      data: {
        ...raw,
        // A result exactly at the cap may have more rows upstream. Treat it
        // as incomplete rather than silently deriving absent campaign goals.
        campaignGoalsComplete: campaignGoals.data.length < GOOGLE_ADS_MAX_RESULT_ROWS,
      },
      metadata: {
        apiVersion: GOOGLE_ADS_API_VERSION,
        requests: [
          conversionActions.metadata,
          customerGoals.metadata,
          campaignGoals.metadata,
          customGoals.metadata,
          campaignConfigs.metadata,
        ],
      },
    }
  }

  /**
   * Campaigns ranked by spend over a window, removed ones included, so the
   * bounded daily-metrics query can be scoped to where the money actually went
   * rather than to the lowest campaign ids.
   */
  async getCampaignSpendRanking(
    customerId: string,
    options: GoogleAdsDailyMetricsOptions,
  ): Promise<GoogleAdsResult<GoogleAdsDailyCampaignMetricsRow[]>> {
    return this.#searchStream(
      customerId,
      'campaign-spend-ranking',
      buildCampaignSpendRankingQuery(options),
    )
  }

  async getDailyCampaignMetrics(
    customerId: string,
    options: GoogleAdsDailyMetricsOptions,
  ): Promise<GoogleAdsResult<GoogleAdsDailyCampaignMetricsRow[]>> {
    return this.#searchStream(
      customerId,
      'daily-campaign-metrics',
      buildDailyCampaignMetricsQuery(options),
    )
  }

  async getDailyConversionMetrics(
    customerId: string,
    options: GoogleAdsDailyMetricsOptions,
  ): Promise<GoogleAdsResult<GoogleAdsDailyConversionMetricsRow[]>> {
    return this.#searchStream(
      customerId,
      'daily-conversion-metrics',
      buildDailyConversionMetricsQuery(options),
    )
  }

  async #searchStream<T>(
    customerId: string,
    operation: GoogleAdsReadOperation,
    query: string,
  ): Promise<GoogleAdsResult<T[]>> {
    const normalizedCustomerId = normalizeGoogleAdsCustomerId(customerId)
    const result = await this.#requestJson<GoogleAdsSearchStreamChunk<T>[]>(
      operation,
      `/customers/${normalizedCustomerId}/googleAds:searchStream`,
      {
        method: 'POST',
        body: JSON.stringify({ query }),
      },
      true,
    )

    if (!Array.isArray(result.data)) {
      throw new GoogleAdsApiError(
        'Google Ads API returned an invalid searchStream response',
        502,
        undefined,
        result.metadata.requestId,
      )
    }

    const rows: T[] = []
    let requestId = result.metadata.requestId
    for (const chunk of result.data) {
      if (Array.isArray(chunk.results)) rows.push(...chunk.results)
      requestId ??= safeRequestId(chunk.requestId)
    }

    return {
      data: rows,
      metadata: {
        ...result.metadata,
        ...(requestId ? { requestId } : {}),
      },
    }
  }

  async #requestJson<T>(
    operation: GoogleAdsReadOperation,
    path: string,
    init: Pick<RequestInit, 'method' | 'body'>,
    includeLoginCustomerId: boolean,
  ): Promise<GoogleAdsResult<T>> {
    const maxRetries = this.#retry.maxRetries ?? GOOGLE_ADS_MAX_RETRIES
    const baseDelayMs = this.#retry.baseDelayMs ?? GOOGLE_ADS_RETRY_BASE_DELAY_MS
    const maxDelayMs = this.#retry.maxDelayMs ?? GOOGLE_ADS_RETRY_MAX_DELAY_MS

    return withRetry(
      () => this.#requestJsonOnce<T>(operation, path, init, includeLoginCustomerId),
      {
        maxRetries,
        baseDelayMs,
        maxDelayMs,
        jitter: this.#retry.jitter,
        sleep: this.#retry.sleep,
        isRetryable: isRetryableHttpError,
        computeDelayMs: (_attempt, error, defaultMs) =>
          retryAfterDelayMs(error) ?? defaultMs,
      },
    )
  }

  async #requestJsonOnce<T>(
    operation: GoogleAdsReadOperation,
    path: string,
    init: Pick<RequestInit, 'method' | 'body'>,
    includeLoginCustomerId: boolean,
  ): Promise<GoogleAdsResult<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#accessToken}`,
      'Content-Type': 'application/json',
      'developer-token': this.#developerToken,
    }
    if (includeLoginCustomerId && this.#loginCustomerId) {
      headers['login-customer-id'] = this.#loginCustomerId
    }

    let response: Response
    try {
      response = await this.#fetch(`${GOOGLE_ADS_API_BASE}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      })
    } catch (error) {
      const detail = describeError(error)
      throw new GoogleAdsApiError(
        `Google Ads API request failed: ${sanitizeText(detail, this.#secrets())}`,
      )
    }

    const headerRequestId = safeRequestId(response.headers.get('request-id'))
      ?? safeRequestId(response.headers.get('google-ads-request-id'))
    const retryAfter = response.headers.get('retry-after') ?? undefined

    let body: string
    try {
      body = await response.text()
    } catch (error) {
      const detail = describeError(error)
      throw new GoogleAdsApiError(
        `Google Ads API response failed: ${sanitizeText(detail, this.#secrets())}`,
        undefined,
        undefined,
        headerRequestId,
      )
    }

    let payload: unknown
    try {
      payload = body.trim() === '' ? null : JSON.parse(body)
    } catch {
      throw new GoogleAdsApiError(
        'Google Ads API returned invalid JSON',
        502,
        undefined,
        headerRequestId,
        retryAfter,
      )
    }

    if (!response.ok) {
      const provider = providerErrorParts(payload)
      const requestId = headerRequestId ?? provider.requestId
      const rawDetail = provider.message ?? (body.trim() || response.statusText)
      const detail = sanitizeText(rawDetail, this.#secrets())
      throw new GoogleAdsApiError(
        `Google Ads API error (${response.status}): ${detail}`,
        response.status,
        provider.providerStatus,
        requestId,
        retryAfter,
      )
    }

    if (payload === null) {
      throw new GoogleAdsApiError(
        'Google Ads API returned an empty response',
        502,
        undefined,
        headerRequestId,
      )
    }

    return {
      data: payload as T,
      metadata: {
        apiVersion: GOOGLE_ADS_API_VERSION,
        operation,
        ...(headerRequestId ? { requestId: headerRequestId } : {}),
      },
    }
  }

  #secrets(): readonly string[] {
    return [this.#accessToken, this.#developerToken]
  }
}
