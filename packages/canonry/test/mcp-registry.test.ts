import { selectNativeDispatchCases, startNativeMcpDispatchFixture, type NativeDispatchCase } from './mcp-dispatch-fixture.js'
import { registryDispatchCases, dedicatedDispatchCases } from './fixtures/mcp-dispatch-cases.js'
import { createServer, type ServerResponse } from 'node:http'
import { describe, expect, it, test, vi } from 'vitest'
import { z } from 'zod'
import { buildOpenApiDocument } from '../../api-routes/src/openapi.js'
import { CliError } from '../src/cli-error.js'
import { ApiClient as RealApiClient, type ApiClient } from '../src/client.js'
import {
  canonryMcpTools,
} from '../src/mcp/tool-registry.js'
import { MCP_OPENAPI_OPERATION_CLASSIFICATIONS } from '../src/mcp/openapi-classification.js'
import { createCanonryMcpServer, createCanonryMcpServerWithCatalog, getCanonryMcpTools } from '../src/mcp/server.js'
import { jsonToolResult, withToolErrors } from '../src/mcp/results.js'
import { CANONRY_MCP_TIERS, CANONRY_MCP_TOOLKITS } from '../src/mcp/toolkits.js'

/** These stored reads now request the API's compact page by default. */
function compactMeasurementCase(scenario: NativeDispatchCase): NativeDispatchCase {
  if (scenario.tool !== 'canonry_measurement_overview' && scenario.tool !== 'canonry_measurement_portfolio_summary') return scenario
  return {
    ...scenario,
    requests: scenario.requests.map(request => ({ ...request, query: [['compact', 'true'], ...request.query] })),
  }
}

const expectedToolNames = [
  'canonry_sentiment_settings',
  'canonry_sentiment_configure',
  'canonry_sentiment',
  'canonry_sentiment_evidence',
  'canonry_sentiment_compare',
  'canonry_sentiment_backfill_preview',
  'canonry_sentiment_backfill',
  'canonry_sentiment_jobs',
  'canonry_sentiment_job',

  'canonry_visibility_report',
  'canonry_query_tracking_workspace',
  'canonry_query_tracking_preview',
  'canonry_query_tracking_commit',
  'canonry_projects_list',
  'canonry_project_get',
  'canonry_project_delete_preview',
  'canonry_project_overview',
  'canonry_organic_evidence',
  'canonry_analytics_metrics',
  'canonry_analytics_sources',
  'canonry_competitor_landscape',
  'canonry_search',
  'canonry_doctor',
  'canonry_project_export',
  'canonry_results_clear',
  'canonry_project_history',
  'canonry_history_global',
  'canonry_runs_list',
  'canonry_runs_latest',
  'canonry_run_get',
  'canonry_run_completeness',
  'canonry_run_fill',
  'canonry_timeline_get',
  'canonry_snapshots_list',
  'canonry_snapshots_diff',
  'canonry_insights_list',
  'canonry_insight_get',
  'canonry_health_latest',
  'canonry_health_history',
  'canonry_citations_visibility',
  'canonry_visibility_stats',
  'canonry_visibility_compare',
  'canonry_content_targets',
  'canonry_content_dismissals',
  'canonry_content_dismiss',
  'canonry_content_restore',
  'canonry_content_brief',
  'canonry_content_map',
  'canonry_content_sources',
  'canonry_content_gaps',
  'canonry_queries_list',
  'canonry_keywords_list',
  'canonry_competitors_list',
  'canonry_schedule_get',
  'canonry_schedules_list',
  'canonry_notification_events',
  'canonry_backlinks_latest_release',
  'canonry_backlinks_domains',
  'canonry_backlinks_sources',
  'canonry_settings_get',
  'canonry_key_self',
  'canonry_logs_list',
  'canonry_telemetry_update',
  'canonry_provider_settings_update',
  'canonry_providers_reload',
  'canonry_telemetry_get',
  'canonry_google_connections_list',
  'canonry_gsc_performance',
  'canonry_gsc_performance_daily',
  'canonry_gsc_top_pages',
  'canonry_gsc_query_totals',
  'canonry_gsc_inspections',
  'canonry_gsc_deindexed',
  'canonry_gsc_coverage',
  'canonry_gsc_coverage_history',
  'canonry_bing_coverage',
  'canonry_gsc_sitemaps',
  'canonry_gsc_sitemaps_submit',
  'canonry_ga_status',
  'canonry_ga_properties',
  'canonry_ga_measurement_analysis',
  'canonry_ga_search_landing_pages',
  'canonry_ga_traffic',
  'canonry_ga_coverage',
  'canonry_ga_ai_referral_history',
  'canonry_ga_ai_referral_daily',
  'canonry_ga_social_referral_history',
  'canonry_ga_social_referral_trend',
  'canonry_ga_attribution_trend',
  'canonry_ga_session_history',
  'canonry_gbp_accounts',
  'canonry_gbp_locations',
  'canonry_gbp_locations_discover',
  'canonry_gbp_location_select',
  'canonry_gbp_disconnect',
  'canonry_gbp_sync',
  'canonry_gbp_metrics',
  'canonry_gbp_keywords',
  'canonry_gbp_place_actions',
  'canonry_gbp_lodging',
  'canonry_gbp_attributes',
  'canonry_gbp_places',
  'canonry_gbp_reviews',
  'canonry_gbp_summary',
  'canonry_traffic_sources_list',
  'canonry_traffic_source_get',
  'canonry_traffic_status',
  'canonry_traffic_analytics',
  'canonry_traffic_referral_assessment',
  'canonry_traffic_events',
  'canonry_traffic_connect_cloud_run',
  'canonry_traffic_connect_wordpress',
  'canonry_traffic_connect_vercel',
  'canonry_traffic_sync',
  'canonry_traffic_backfill',
  'canonry_traffic_reset',
  'canonry_snapshot',
  'canonry_project_upsert',
  'canonry_apply_config',
  'canonry_queries_generate',
  'canonry_keywords_generate',
  'canonry_queries_replace',
  'canonry_queries_replace_preview',
  'canonry_keywords_replace',
  'canonry_measurement_discovery',
  'canonry_measurement_plan_get',
  'canonry_measurement_plan_versions',
  'canonry_measurement_plan_version_get',
  'canonry_measurement_plan_compile_preview',
  'canonry_measurement_plan_diff_preview',
  'canonry_measurement_plan_publish',
  'canonry_measurement_plan_segment_retire',
  'canonry_measurement_setup',
  'canonry_measurement_overview',
  'canonry_measurement_property_evidence',
  'canonry_measurement_portfolio_summary',
  'canonry_measurement_property_questions',
  'canonry_measurement_question_result',
  'canonry_measurement_property_competitors',
  'canonry_measurement_changes',
  'canonry_measurement_data_quality',
  'canonry_measurement_draft_get',
  'canonry_measurement_draft_targets',
  'canonry_measurement_draft_assignments',
  'canonry_measurement_draft_groups',
  'canonry_measurement_query_sets',
  'canonry_measurement_query_set_get',
  'canonry_measurement_query_templates',
  'canonry_measurement_draft_action',
  'canonry_measurement_plan_deactivate',
  'canonry_measurement_query_set_upsert',
  'canonry_measurement_query_set_delete',
  'canonry_measurement_query_template_upsert',
  'canonry_measurement_query_template_delete',
  'canonry_measurement_query_template_apply',
  'canonry_measurement_report',
  'canonry_run_trigger',
  'canonry_feedback',
  'canonry_run_cancel',
  'canonry_queries_add',
  'canonry_keywords_add',
  'canonry_queries_remove',
  'canonry_keywords_remove',
  'canonry_competitors_add',
  'canonry_competitors_aliases_set',
  'canonry_competitors_auto_aliases_detect',
  'canonry_competitors_auto_aliases_apply',
  'canonry_competitors_aliases_block',
  'canonry_competitors_aliases_unblock',
  'canonry_competitors_remove',
  'canonry_schedule_set',
  'canonry_schedule_delete',
  'canonry_insight_dismiss',
  'canonry_memory_list',
  'canonry_memory_set',
  'canonry_memory_forget',
  'canonry_agent_conversations_list',
  'canonry_agent_conversations_get',
  'canonry_agent_conversations_new',
  'canonry_agent_conversations_resume',
  'canonry_agent_conversations_delete',
  'canonry_agent_clear',
  'canonry_agent_webhook_attach',
  'canonry_agent_webhook_detach',
  'canonry_research_run_start',
  'canonry_research_batch_start',
  'canonry_research_runs_list',
  'canonry_research_run_get',
  'canonry_discover_run_start',
  'canonry_discover_sessions_list',
  'canonry_discover_session_get',
  'canonry_discover_harvest',
  'canonry_discover_promote_preview',
  'canonry_discover_promote',
  'canonry_site_health_overview',
  'canonry_site_health_page_audit',
  'canonry_site_health_subgraph',
  'canonry_site_health_path',
  'canonry_site_health_changes',
  'canonry_technical_aeo_score',
  'canonry_technical_aeo_pages',
  'canonry_technical_aeo_trend',
  'canonry_technical_aeo_crawl',
  'canonry_technical_aeo_crawl_pages',
  'canonry_technical_aeo_structure',
  'canonry_technical_aeo_internal_links',
  'canonry_technical_aeo_link_neighbors',
  'canonry_technical_aeo_dead_links',
  'canonry_technical_aeo_run',
  'canonry_google_ads_status',
  'canonry_google_ads_customers',
  'canonry_conversion_tracking_options',
  'canonry_google_ads_performance',
  'canonry_google_ads_snapshots',
  'canonry_google_ads_snapshot_get',
  'canonry_google_ads_sync',
  'canonry_gtm_status',
  'canonry_gtm_accounts',
  'canonry_gtm_containers',
  'canonry_gtm_workspaces',
  'canonry_gtm_snapshots',
  'canonry_gtm_snapshot_get',
  'canonry_gtm_sync',
  'canonry_conversion_tracking_contracts',
  'canonry_conversion_tracking_contract_get',
  'canonry_conversion_tracking_integrity',
  'canonry_ads_status',
  'canonry_ads_account',
  'canonry_ads_geo_search',
  'canonry_ads_conversion_pixels',
  'canonry_ads_conversion_event_settings',
  'canonry_ads_campaigns',
  'canonry_ads_insights',
  'canonry_ads_summary',
  'canonry_ads_delivery_diagnostics',
  'canonry_ads_live_delivery',
  'canonry_ads_operations_unresolved',
  'canonry_ads_operation_get',
  'canonry_ads_operation_reconcile',
  'canonry_ads_operation_resume_activation',
  'canonry_ads_image_upload',
  'canonry_ads_campaign_create',
  'canonry_ads_campaign_update',
  'canonry_ads_campaign_activate_tree',
  'canonry_ads_campaign_pause',
  'canonry_ads_ad_group_create',
  'canonry_ads_ad_group_update',
  'canonry_ads_ad_group_pause',
  'canonry_ads_ad_create',
  'canonry_ads_ad_update',
  'canonry_ads_ad_pause',
  'canonry_ads_sync',
] as const

describe('MCP tool registry', () => {
  it('exposes snapshot selection as a quota-spending tool with optional selectors', () => {
    const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_snapshot')!
    expect(tool).toMatchObject({ access: 'write', tier: 'discovery', annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true } })
    expect(getCanonryMcpTools('read-only').some(candidate => candidate.name === tool.name)).toBe(false)
    const input = { companyName: 'Acme', domain: 'acme.example.com' }
    expect(tool.inputSchema.safeParse(input).success).toBe(true)
    expect(tool.inputSchema.safeParse({ ...input, providerMode: 'browser', queries: ['best widgets'] }).success).toBe(true)
    for (const invalid of [{ providerMode: 'invalid' }, { providers: [] }, { providers: [' '] }, { queries: ['widgets'], phrases: ['widgets'] }]) {
      expect(tool.inputSchema.safeParse({ ...input, ...invalid }).success).toBe(false)
    }
    const schema = z.toJSONSchema(tool.inputSchema)
    expect(schema.required).toEqual(['companyName', 'domain'])
    const apiSchema = buildOpenApiDocument().components.schemas.SnapshotRequest
    expect(apiSchema.required).toEqual(['companyName', 'domain'])
  })

  it('exposes optional requested-model competitor groups without widening read-only access', () => {
    const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_competitor_landscape')!
    expect(tool).toMatchObject({ access: 'read', tier: 'monitoring', annotations: { readOnlyHint: true } })
    expect(getCanonryMcpTools('read-only').map(candidate => candidate.name)).toContain(tool.name)
    const input = {
      project: 'acme', groupBy: 'model', provider: 'openai', model: 'gpt-test',
      groupKey: 'north', queryClass: 'non-brand', location: 'nyc',
    }
    expect(tool.inputSchema.parse(input)).toEqual(input)
    expect(tool.inputSchema.safeParse({ project: 'acme', groupBy: 'model', scope: 'all-markets' }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ project: 'acme', model: 'gpt-test' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ project: 'acme', groupBy: 'served-model' }).success).toBe(false)
    expect(tool.description).toContain('exact requested model ID')
    expect(schemaProperty(inputSchemaFor(tool.name), 'groupBy')).toMatchObject({ const: 'model' })
  })

  it('carries qualifiedAliases on project upsert and apply, and names the omitted-keeps exception', () => {
    const upsert = canonryMcpTools.find(candidate => candidate.name === 'canonry_project_upsert')!
    const request = { displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en', aliases: ['AcmeNYC'] }
    expect(upsert.inputSchema.parse({ project: 'acme', request: { ...request, qualifiedAliases: ['AcmeNYC'] } }))
      .toMatchObject({ request: { qualifiedAliases: ['AcmeNYC'] } })
    expect(upsert.inputSchema.parse({ project: 'acme', request }).request).not.toHaveProperty('qualifiedAliases')
    expect(upsert.inputSchema.safeParse({ project: 'acme', request: { ...request, qualifiedAliases: Array.from({ length: 21 }, (_, i) => `Alias ${i}`) } }).success).toBe(false)
    const requestSchema = z.toJSONSchema(upsert.inputSchema).properties?.request
    if (typeof requestSchema !== 'object' || requestSchema === null) {
      throw new Error('Expected the published upsert request to be an object schema')
    }
    expect(requestSchema.properties).toHaveProperty('qualifiedAliases')
    expect(requestSchema.required ?? []).not.toContain('qualifiedAliases')
    expect(upsert.description).toContain('An omitted qualifiedAliases')
    expect(upsert.description).toContain('keeps the stored list, minus names that no longer qualify (a removed alias, a spelling of the display name, or a competitor\'s name); send [] to clear it')

    const apply = canonryMcpTools.find(candidate => candidate.name === 'canonry_apply_config')!
    const config = { apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: 'acme' }, spec: { ...request, qualifiedAliases: ['AcmeNYC'] } }
    expect(apply.inputSchema.parse({ config }).config.spec.qualifiedAliases).toEqual(['AcmeNYC'])
    expect(apply.description).toContain('an omitted qualifiedAliases keeps the stored list, minus names that no longer qualify (a removed alias, a spelling of the display name, or a competitor\'s name); send [] to clear it')
  })

  it('carries siteAuditMaxPages on project upsert and apply as an optional 1-50,000 budget or null, and names the omitted-keeps exception', () => {
    const budgetSchema = { anyOf: [{ type: 'integer', minimum: 1, maximum: 50_000 }, { type: 'null' }] }
    const request = { displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en' }

    const upsert = canonryMcpTools.find(candidate => candidate.name === 'canonry_project_upsert')!
    expect(upsert.inputSchema.parse({ project: 'acme', request: { ...request, siteAuditMaxPages: 2_500 } }).request.siteAuditMaxPages).toBe(2_500)
    expect(upsert.inputSchema.parse({ project: 'acme', request: { ...request, siteAuditMaxPages: null } }).request.siteAuditMaxPages).toBeNull()
    // Omitted must stay omitted: a schema default here would overwrite the stored budget on every upsert.
    expect(upsert.inputSchema.parse({ project: 'acme', request }).request).not.toHaveProperty('siteAuditMaxPages')
    for (const invalid of [0, 50_001, 2.5]) {
      expect(upsert.inputSchema.safeParse({ project: 'acme', request: { ...request, siteAuditMaxPages: invalid } }).success, String(invalid)).toBe(false)
    }
    const upsertRequest = schemaProperty(inputSchemaFor('canonry_project_upsert'), 'request')
    expect(schemaProperty(upsertRequest, 'siteAuditMaxPages')).toEqual(budgetSchema)
    expect(upsertRequest.required ?? []).not.toContain('siteAuditMaxPages')
    expect(upsert.description).toContain('An omitted siteAuditMaxPages (the Site Health page budget for scans that set none, 1 to 50,000) keeps the stored budget; send null for the full site.')

    const apply = canonryMcpTools.find(candidate => candidate.name === 'canonry_apply_config')!
    const config = { apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: 'acme' }, spec: request }
    expect(apply.inputSchema.parse({ config: { ...config, spec: { ...request, siteAuditMaxPages: 300 } } }).config.spec.siteAuditMaxPages).toBe(300)
    expect(apply.inputSchema.parse({ config: { ...config, spec: { ...request, siteAuditMaxPages: null } } }).config.spec.siteAuditMaxPages).toBeNull()
    expect(apply.inputSchema.parse({ config }).config.spec).not.toHaveProperty('siteAuditMaxPages')
    expect(apply.inputSchema.safeParse({ config: { ...config, spec: { ...request, siteAuditMaxPages: 50_001 } } }).success).toBe(false)
    const applySpec = schemaProperty(schemaProperty(inputSchemaFor('canonry_apply_config'), 'config'), 'spec')
    expect(schemaProperty(applySpec, 'siteAuditMaxPages')).toEqual(budgetSchema)
    expect(applySpec.required ?? []).not.toContain('siteAuditMaxPages')
    expect(apply.description).toContain('An omitted siteAuditMaxPages keeps the stored Site Health page budget (null means the full site).')
  })

  it('carries competitorAutoAliases on project upsert and apply as an optional off|preview|apply mode that an omission keeps', () => {
    const modeSchema = { type: 'string', enum: ['off', 'preview', 'apply'] }
    const request = { displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en' }

    const upsert = canonryMcpTools.find(candidate => candidate.name === 'canonry_project_upsert')!
    expect(upsert.inputSchema.parse({ project: 'acme', request: { ...request, competitorAutoAliases: 'apply' } }).request.competitorAutoAliases).toBe('apply')
    // Omitted must stay omitted: a schema default here would reset the stored mode on every upsert.
    expect(upsert.inputSchema.parse({ project: 'acme', request }).request).not.toHaveProperty('competitorAutoAliases')
    expect(upsert.inputSchema.safeParse({ project: 'acme', request: { ...request, competitorAutoAliases: 'auto' } }).success).toBe(false)
    const upsertRequest = schemaProperty(inputSchemaFor('canonry_project_upsert'), 'request')
    expect(schemaProperty(upsertRequest, 'competitorAutoAliases')).toMatchObject(modeSchema)
    expect(schemaProperty(upsertRequest, 'competitorAutoAliases').description).toContain('Omit to keep the stored mode')
    expect(upsertRequest.required ?? []).not.toContain('competitorAutoAliases')
    expect(upsert.description).toContain('An omitted competitorAutoAliases keeps the stored answer-derived competitor alias mode')

    const apply = canonryMcpTools.find(candidate => candidate.name === 'canonry_apply_config')!
    const config = { apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: 'acme' }, spec: request }
    expect(apply.inputSchema.parse({ config: { ...config, spec: { ...request, competitorAutoAliases: 'off' } } }).config.spec.competitorAutoAliases).toBe('off')
    expect(apply.inputSchema.parse({ config }).config.spec).not.toHaveProperty('competitorAutoAliases')
    const applySpec = schemaProperty(schemaProperty(inputSchemaFor('canonry_apply_config'), 'config'), 'spec')
    expect(schemaProperty(applySpec, 'competitorAutoAliases')).toMatchObject(modeSchema)
    expect(schemaProperty(applySpec, 'competitorAutoAliases').description).toContain('Omit to keep the stored mode')
    expect(apply.description).toContain('An omitted competitorAutoAliases keeps the stored answer-derived competitor alias mode (off, preview or apply).')

    // The apply-now tool stores in every mode; the dry run says what the unattended pass does per mode.
    expect(canonryMcpTools.find(candidate => candidate.name === 'canonry_competitors_auto_aliases_apply')!.description)
      .toContain('whatever the project\'s competitorAutoAliases mode')
    expect(canonryMcpTools.find(candidate => candidate.name === 'canonry_competitors_auto_aliases_detect')!.description)
      .toContain('`apply` stores its result, `preview` (the default) only logs it, `off` skips it')
  })

  it('tells agents each visibility population carries its change since the previous sweep', () => {
    const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_visibility_report')!
    expect(tool.description).toContain(
      'Each population carries `comparison`, the change versus the previous eligible whole-project sweep when both are complete and comparable; it is absent when that sweep cannot be read.',
    )
  })

  it('sends an agent on an Advanced project from mode simple to mode advanced', async () => {
    const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_visibility_report')!
    const getVisibilityReport = vi.fn().mockResolvedValue({ ok: true })
    const listMeasurementPlanVersions = vi.fn()
    const client = { getVisibilityReport, listMeasurementPlanVersions } as unknown as ApiClient
    const advanced = { versions: [{ revision: 2, checksum: 'b', createdAt: '2026-09-02T00:00:00.000Z', active: true }] }

    // mode simple on a project with an active plan would read only pre-plan
    // sweeps, with or without a window, so it is refused before the report read.
    for (const input of [
      { project: 'acme', mode: 'simple' },
      { project: 'acme', mode: 'simple', from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' },
    ]) {
      listMeasurementPlanVersions.mockResolvedValueOnce(advanced)
      const refused = await tool.handler(client, tool.inputSchema.parse(input)).catch((error: unknown) => error)
      expect(refused, JSON.stringify(input)).toBeInstanceOf(CliError)
      expect(refused).toMatchObject({ code: 'VALIDATION_ERROR', details: { project: 'acme', mode: 'simple' } })
      expect((refused as CliError).message).toContain('Use mode "advanced", or omit mode.')
    }
    expect(getVisibilityReport).not.toHaveBeenCalled()

    // A pinned pre-plan run is still readable, and needs no plan lookup.
    listMeasurementPlanVersions.mockClear()
    await tool.handler(client, tool.inputSchema.parse({ project: 'acme', mode: 'simple', runId: 'pre-plan-run' }))
    expect(listMeasurementPlanVersions).not.toHaveBeenCalled()
    expect(getVisibilityReport).toHaveBeenLastCalledWith('acme', expect.objectContaining({ mode: 'simple', runId: 'pre-plan-run' }))

    // A project with no active plan (none published, or only inactive
    // revisions) reads simple mode as before.
    for (const versions of [[], [{ revision: 1, checksum: 'a', createdAt: '2026-09-01T00:00:00.000Z', active: false }]]) {
      listMeasurementPlanVersions.mockResolvedValueOnce({ versions })
      await expect(tool.handler(client, tool.inputSchema.parse({ project: 'acme', mode: 'simple' }))).resolves.toEqual({ ok: true })
      expect(getVisibilityReport).toHaveBeenLastCalledWith('acme', expect.objectContaining({ mode: 'simple' }))
    }

    // The default and advanced reads never look up the plan.
    listMeasurementPlanVersions.mockClear()
    for (const mode of [undefined, 'auto', 'advanced']) {
      await tool.handler(client, tool.inputSchema.parse({ project: 'acme', ...(mode === undefined ? {} : { mode }) }))
    }
    expect(listMeasurementPlanVersions).not.toHaveBeenCalled()
    expect(tool.description).toContain('On an Advanced project use mode advanced, or omit mode')
  })

  it('defers Cloudflare connect to the local secret-safe CLI workflow', () => {
    expect(canonryMcpTools.map(tool => tool.name)).not.toContain('canonry_traffic_connect_cloudflare')
    expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS[
      'POST /api/v1/projects/{name}/traffic/connect/cloudflare'
    ]).toBe('deferred')
  })

  it('exposes bounded Site Health reads as read-only monitoring tools', () => {
    const expected = [
      ['canonry_site_health_overview', 'GET /api/v1/projects/{name}/technical-aeo/crawl'],
      ['canonry_site_health_page_audit', 'GET /api/v1/projects/{name}/technical-aeo/crawl/pages/audit'],
      ['canonry_site_health_subgraph', 'GET /api/v1/projects/{name}/technical-aeo/subgraph'],
      ['canonry_site_health_path', 'GET /api/v1/projects/{name}/technical-aeo/path'],
      ['canonry_site_health_changes', 'GET /api/v1/projects/{name}/technical-aeo/changes'],
      ['canonry_technical_aeo_crawl', 'GET /api/v1/projects/{name}/technical-aeo/crawl'],
      ['canonry_technical_aeo_crawl_pages', 'GET /api/v1/projects/{name}/technical-aeo/crawl/pages'],
      ['canonry_technical_aeo_structure', 'GET /api/v1/projects/{name}/technical-aeo/structure'],
      ['canonry_technical_aeo_internal_links', 'GET /api/v1/projects/{name}/technical-aeo/internal-links'],
      ['canonry_technical_aeo_link_neighbors', 'GET /api/v1/projects/{name}/technical-aeo/internal-links/neighbors'],
      ['canonry_technical_aeo_dead_links', 'GET /api/v1/projects/{name}/technical-aeo/dead-links'],
    ] as const

    for (const [name, operation] of expected) {
      const tool = canonryMcpTools.find(candidate => candidate.name === name)
      expect(tool, name).toMatchObject({
        access: 'read',
        tier: 'monitoring',
        openApiOperations: [operation],
        annotations: { readOnlyHint: true },
      })
      expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS[operation]).toBe('included')
    }

    const graphOperation = 'GET /api/v1/projects/{name}/technical-aeo/graph'
    expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS[graphOperation]).toBe('deferred')
    expect(canonryMcpTools.flatMap(tool => tool.openApiOperations)).not.toContain(graphOperation)

    const livePreviewOperation = 'GET /api/v1/projects/{name}/technical-aeo/runs/{runId}/page-health-preview'
    expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS[livePreviewOperation]).toBe('excluded-protocol')
    expect(canonryMcpTools.flatMap(tool => tool.openApiOperations)).not.toContain(livePreviewOperation)

    expect(getCanonryMcpTools('read-only').map(tool => tool.name)).toEqual(expect.arrayContaining(
      expected.map(([name]) => name),
    ))

    const pages = canonryMcpTools.find(candidate => candidate.name === 'canonry_technical_aeo_crawl_pages')!
    expect(pages.inputSchema.safeParse({ project: 'acme', limit: 200, cursor: 'next' }).success).toBe(true)
    expect(pages.inputSchema.safeParse({ project: 'acme', limit: 201 }).success).toBe(false)

    const neighbors = canonryMcpTools.find(candidate => candidate.name === 'canonry_technical_aeo_link_neighbors')!
    expect(neighbors.inputSchema.safeParse({ project: 'acme', nodeKey: 'node-1', limit: 100 }).success).toBe(true)
    expect(neighbors.inputSchema.safeParse({ project: 'acme', limit: 100 }).success).toBe(false)

    const pageAudit = canonryMcpTools.find(candidate => candidate.name === 'canonry_site_health_page_audit')!
    expect(pageAudit.inputSchema.safeParse({ project: 'acme', nodeKey: 'node-1' }).success).toBe(true)
    expect(pageAudit.inputSchema.safeParse({ project: 'acme', url: 'https://acme.test/' }).success).toBe(true)
    expect(pageAudit.inputSchema.safeParse({ project: 'acme' }).success).toBe(false)
    expect(pageAudit.inputSchema.safeParse({ project: 'acme', nodeKey: 'node-1', url: 'https://acme.test/' }).success).toBe(false)

    const subgraph = canonryMcpTools.find(candidate => candidate.name === 'canonry_site_health_subgraph')!
    expect(subgraph.inputSchema.parse({ project: 'acme' })).toMatchObject({ maxNodes: 25, maxEdges: 50 })
    expect(subgraph.inputSchema.safeParse({ project: 'acme', maxNodes: 26 }).success).toBe(false)
    expect(subgraph.inputSchema.safeParse({ project: 'acme', maxEdges: 51 }).success).toBe(false)
    expect(subgraph.description).toContain('countAccuracy=lower-bound')

    const path = canonryMcpTools.find(candidate => candidate.name === 'canonry_site_health_path')!
    expect(path.description).toContain('complete')
    expect(path.description).toContain('termination')

    const changes = canonryMcpTools.find(candidate => candidate.name === 'canonry_site_health_changes')!
    expect(changes.inputSchema.parse({ project: 'acme' })).toMatchObject({ limit: 25 })
    expect(changes.inputSchema.safeParse({ project: 'acme', limit: 26 }).success).toBe(false)

    const run = canonryMcpTools.find(candidate => candidate.name === 'canonry_technical_aeo_run')!
    expect(run.description).toContain('the engine derives the link-observation budget from that page count')
    expect(run.description).toContain('Without maxPages it uses the project\'s saved page budget (siteAuditMaxPages), else the full site (up to 50,000 pages)')
    expect(schemaProperty(inputSchemaFor('canonry_technical_aeo_run'), 'maxPages')).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 50_000,
      description: expect.stringContaining('Omitted uses the project\'s saved budget (siteAuditMaxPages'),
    })
    // An omitted budget is sent as omitted, so the server can apply the saved one.
    expect(run.inputSchema.parse({ project: 'acme' })).not.toHaveProperty('maxPages')
    expect(run.inputSchema.safeParse({ project: 'acme', maxPages: 50_000, maxEdges: 1_000_000, maxDepth: 100, checkDeadLinks: true }).success).toBe(true)
    expect(run.inputSchema.safeParse({ project: 'acme', maxPages: 0 }).success).toBe(false)
    expect(run.inputSchema.safeParse({ project: 'acme', maxPages: 50_001 }).success).toBe(false)
    expect(run.inputSchema.safeParse({ project: 'acme', maxEdges: 1_000_001 }).success).toBe(false)
  })

  it('includes the complete measurement-plan API surface', async () => {
    const expected = [
      ['canonry_measurement_discovery', 'write', 'POST /api/v1/projects/{name}/measurement-discovery'],
      ['canonry_measurement_plan_get', 'read', 'GET /api/v1/projects/{name}/measurement-plan'],
      ['canonry_measurement_plan_versions', 'read', 'GET /api/v1/projects/{name}/measurement-plan/versions'],
      ['canonry_measurement_plan_version_get', 'read', 'GET /api/v1/projects/{name}/measurement-plan/versions/{revision}'],
      ['canonry_measurement_plan_compile_preview', 'write', 'POST /api/v1/projects/{name}/measurement-plan/compile-preview'],
      ['canonry_measurement_plan_diff_preview', 'write', 'POST /api/v1/projects/{name}/measurement-plan/diff-preview'],
      ['canonry_measurement_plan_publish', 'write', 'PUT /api/v1/projects/{name}/measurement-plan'],
      ['canonry_measurement_plan_segment_retire', 'write', 'POST /api/v1/projects/{name}/measurement-plan/segments/{stableKey}/retire'],
      ['canonry_measurement_overview', 'read', 'GET /api/v1/projects/{name}/measurement-overview'],
      ['canonry_measurement_property_evidence', 'read', 'GET /api/v1/projects/{name}/measurement-property-evidence'],
      ['canonry_measurement_portfolio_summary', 'read', 'GET /api/v1/projects/{name}/measurement-portfolio-summary'],
      ['canonry_measurement_property_questions', 'read', 'GET /api/v1/projects/{name}/measurement-property-questions'],
      ['canonry_measurement_question_result', 'read', 'GET /api/v1/projects/{name}/measurement-question-result'],
      ['canonry_measurement_property_competitors', 'read', 'GET /api/v1/projects/{name}/measurement-property-competitors'],
      ['canonry_measurement_changes', 'read', 'GET /api/v1/projects/{name}/measurement-changes'],
      ['canonry_measurement_data_quality', 'read', 'GET /api/v1/projects/{name}/measurement-data-quality'],
      ['canonry_measurement_report', 'read', 'GET /api/v1/projects/{name}/measurement-report'],
    ] as const

    for (const [name, access, operation] of expected) {
      expect(canonryMcpTools.find(tool => tool.name === name), name).toMatchObject({
        access,
        openApiOperations: [operation],
      })
      expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS[operation]).toBe('included')
    }
  })

  it('defaults MCP portfolio comparisons to non-brand without overriding an explicit class', async () => {
    const fixture = await startNativeMcpDispatchFixture()
    try {
      for (const scenario of selectNativeDispatchCases(dedicatedDispatchCases, 'portfolio-defaults')) await fixture.verify(compactMeasurementCase(scenario))
    } finally {
      await fixture.close()
    }
  })

  it('reads analytics sources without the per-query breakdown unless asked, forwarding run and class', async () => {
    const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_analytics_sources')!
    expect(tool.description).toContain('pass `window` to pool every sweep in it')
    expect(tool.description).toContain('Gemini')
    const fixture = await startNativeMcpDispatchFixture()
    try {
      for (const scenario of selectNativeDispatchCases(dedicatedDispatchCases, 'sources-shape')) await fixture.verify(scenario)
    } finally {
      await fixture.close()
    }
  })

  it('reads the latest sweep for class-scoped sources and landscape unless a run or window is given', async () => {
    const sources = canonryMcpTools.find(candidate => candidate.name === 'canonry_analytics_sources')!
    const landscape = canonryMcpTools.find(candidate => candidate.name === 'canonry_competitor_landscape')!
    for (const tool of [sources, landscape]) {
      expect(tool.description).toContain('runIds')
      expect(tool.description).toContain('countUnits')
    }
    expect(landscape.description).toContain('observedNamesTotal` counts distinct names, never answers')
    expect(sources.description).toContain('`domainTotal` is distinct domains, never answers or citations')
    const fixture = await startNativeMcpDispatchFixture()
    try {
      for (const scenario of selectNativeDispatchCases(dedicatedDispatchCases, 'latest-selection')) await fixture.verify(scenario)
    } finally {
      await fixture.close()
    }
  })

  it('defaults an agent\'s Property and change reads to non-brand without overriding an explicit class', async () => {
    const fixture = await startNativeMcpDispatchFixture()
    try {
      for (const scenario of selectNativeDispatchCases(dedicatedDispatchCases, 'property-defaults')) await fixture.verify(scenario)
    } finally {
      await fixture.close()
    }
  })

  it('bounds agent change reads and documents their order, distribution and noise', async () => {
    const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_measurement_changes')!
    expect(tool.inputSchema.safeParse({ project: 'acme', limit: 20 }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ project: 'acme', limit: 21 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ project: 'acme', scope: 'all', groupKey: 'metro-east' }).success).toBe(false)
    expect(schemaProperty(inputSchemaFor(tool.name), 'queryClass')).toMatchObject({ default: 'non-brand' })
    for (const phrase of ['largest move first', 'distribution counts every Property', 'withinNoise true means every move was 2 answers or fewer', 'mentionWithinNoise and citationWithinNoise apply the same rule to each signal alone', 'denominatorChanged true means a rate was taken over a different number of answers', 'metricsByClass', 'totalProperties above the rows returned']) {
      expect(tool.description).toContain(phrase)
    }
    const fixture = await startNativeMcpDispatchFixture()
    try {
      for (const scenario of selectNativeDispatchCases(dedicatedDispatchCases, 'changes-bounds')) await fixture.verify(scenario)
    } finally {
      await fixture.close()
    }
  })

  it('routes completeness to data quality and run completeness, never to a run status or doctor', () => {
    const description = (name: string) => canonryMcpTools.find(candidate => candidate.name === name)!.description
    expect(description('canonry_measurement_data_quality')).toContain('Quote expected, executed and missing')
    expect(description('canonry_measurement_data_quality')).toContain('unattributedByClass')
    expect(description('canonry_measurement_data_quality')).toContain('latestFill')
    expect(description('canonry_measurement_data_quality')).toContain('pass run.displayedRunId to canonry_run_completeness')
    expect(description('canonry_run_completeness')).toContain('missingByProvider')
    expect(description('canonry_run_completeness')).toContain('its zero counts are not a completeness check')
    expect(description('canonry_doctor')).toContain('not whether a sweep completed')
    const overview = description('canonry_project_overview')
    // The shape prompt already states the project type; plan_get is only the fallback.
    expect(overview).toContain('When the system prompt has no Project shape line, call canonry_measurement_plan_get')
    expect(overview).toContain('not a completeness check')
    expect(overview).toContain('canonry_doctor checks configuration and integrations, not sweeps')
    expect(overview).toContain('queryClassScope')
    expect(description('canonry_measurement_property_competitors')).toContain('citedDomains')
    expect(description('canonry_measurement_property_competitors')).toContain('never read those 5 as all')
    expect(description('canonry_visibility_report')).toContain('mode simple reads only pre-plan sweeps, so it is refused there unless runId names one')
  })

  it('forwards measurement-plan inputs to the matching ApiClient methods', async () => {
    const fixture = await startNativeMcpDispatchFixture()
    try {
      for (const scenario of selectNativeDispatchCases(dedicatedDispatchCases, 'measurement-wire')) await fixture.verify(compactMeasurementCase(scenario))
    } finally {
      await fixture.close()
    }
  })

  it('sends the exact measurement-overview filters through ApiClient', async () => {
    const api = await startCaptureApi()
    try {
      const client = new RealApiClient(api.origin, 'cnry_test', { skipProbe: true })
      await client.getMeasurementOverview('acme', {
        scope: 'property',
        targetKey: 'harbor-view',
        queryClass: 'non-brand',
        provider: 'openai',
        location: 'New York, NY',
        from: '2026-07-01',
        to: '2026-07-31',
        runId: 'run-7',
        search: 'harbor',
        cursor: 'next-page',
        limit: 25,
      })

      expect(api.requests).toHaveLength(1)
      const request = new URL(api.requests[0]!, api.origin)
      expect(request.pathname).toBe('/api/v1/projects/acme/measurement-overview')
      expect(Object.fromEntries(request.searchParams)).toEqual({
        scope: 'property',
        targetKey: 'harbor-view',
        queryClass: 'non-brand',
        provider: 'openai',
        location: 'New York, NY',
        from: '2026-07-01',
        to: '2026-07-31',
        runId: 'run-7',
        search: 'harbor',
        cursor: 'next-page',
        limit: '25',
      })
    } finally {
      await api.close()
    }
  })

  it('declares the evidence shape on the property-evidence tool without adding a second tool for it', () => {
    const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_measurement_property_evidence')
    expect(tool).toBeTruthy()

    // The DECLARED schema is what an MCP client validates a call against, so a
    // parameter absent from it is unreachable however the handler behaves.
    expect(tool!.inputSchema.safeParse({ project: 'acme', targetKey: 'harbor-view', shape: 'answers' }).success).toBe(true)
    expect(tool!.inputSchema.safeParse({ project: 'acme', targetKey: 'harbor-view' }).success).toBe(true)
    expect(tool!.inputSchema.safeParse({ project: 'acme', targetKey: 'harbor-view', shape: 'urls' }).success).toBe(false)
    expect(schemaProperty(inputSchemaFor('canonry_measurement_property_evidence'), 'shape')).toMatchObject({
      enum: ['sources', 'answers'],
    })

    // The answer shape is a parameter, never a second operation: adding a tool
    // would move the pinned catalog counts asserted below.
    expect(tool!.openApiOperations).toEqual(['GET /api/v1/projects/{name}/measurement-property-evidence'])
    // Guard the operation, not a `measurement_property*` count: unrelated work
    // legitimately adds tools under that prefix, and a count assertion then
    // fails on a base this change never touched.
    const servingEvidence = canonryMcpTools.filter(candidate => (
      candidate.openApiOperations.includes('GET /api/v1/projects/{name}/measurement-property-evidence')
    ))
    expect(servingEvidence.map(candidate => candidate.name)).toEqual(['canonry_measurement_property_evidence'])
  })

  it('sends the exact measurement-property-evidence filters, shape included, through ApiClient', async () => {
    const api = await startCaptureApi()
    try {
      const client = new RealApiClient(api.origin, 'cnry_test', { skipProbe: true })
      await client.getMeasurementPropertyEvidence('acme', {
        targetKey: 'harbor-view',
        queryClass: 'branded',
        provider: 'openai',
        location: 'New York, NY',
        runId: 'run-7',
        shape: 'answers',
        cursor: 'next-page',
        limit: 25,
      })

      expect(api.requests).toHaveLength(1)
      const request = new URL(api.requests[0]!, api.origin)
      expect(request.pathname).toBe('/api/v1/projects/acme/measurement-property-evidence')
      // A shape that silently never reached the wire would answer with the flat
      // rows under a request that asked for answers.
      expect(Object.fromEntries(request.searchParams)).toEqual({
        targetKey: 'harbor-view',
        queryClass: 'branded',
        provider: 'openai',
        location: 'New York, NY',
        runId: 'run-7',
        shape: 'answers',
        cursor: 'next-page',
        limit: '25',
      })
    } finally {
      await api.close()
    }
  })

  it('ships the curated v1 surface', () => {
    expect(canonryMcpTools.filter(tool => tool.access === 'read')).toHaveLength(165)
    expect(canonryMcpTools.map(tool => tool.name)).toEqual(expectedToolNames)
    const readNames = canonryMcpTools.filter(tool => tool.access === 'read' && !tool.requiresOperator).map(tool => tool.name)
    expect(getCanonryMcpTools('read-only').map(tool => tool.name)).toEqual(readNames)
  })

  it('tags every tool with a tier from the published list', () => {
    for (const tool of canonryMcpTools) {
      expect(CANONRY_MCP_TIERS).toContain(tool.tier)
    }
    const coreNames = canonryMcpTools.filter(tool => tool.tier === 'core').map(tool => tool.name)
    expect(coreNames).toEqual([
      'canonry_projects_list',
      'canonry_project_get',
      'canonry_project_overview',
      'canonry_search',
      'canonry_doctor',
      'canonry_settings_get',
      'canonry_key_self',
      'canonry_apply_config',
      'canonry_run_trigger',
      'canonry_feedback',
      'canonry_run_cancel',
      'canonry_agent_webhook_attach',
    ])
  })

  it('covers every non-core tool with a known toolkit', () => {
    const toolkitNames = new Set(CANONRY_MCP_TOOLKITS.map(toolkit => toolkit.name))
    for (const tool of canonryMcpTools) {
      if (tool.tier === 'core') continue
      expect(toolkitNames.has(tool.tier), `${tool.name} → ${tool.tier}`).toBe(true)
    }
    const counts = new Map<string, number>()
    for (const tool of canonryMcpTools) {
      counts.set(tool.tier, (counts.get(tool.tier) ?? 0) + 1)
    }
    expect(counts.get('monitoring')).toBe(61)
    expect(counts.get('setup')).toBe(66)
    expect(counts.get('gsc')).toBe(11)
    expect(counts.get('ga')).toBe(12)
    expect(counts.get('gbp')).toBe(14)
    expect(counts.get('ads')).toBe(26)
    expect(counts.get('google-ads')).toBe(6)
    expect(counts.get('gtm')).toBe(7)
    expect(counts.get('conversion-tracking')).toBe(3)
    expect(counts.get('traffic')).toBe(12)
    expect(counts.get('agent')).toBe(10)
    expect(counts.get('discovery')).toBe(11)
  })

  it('generates JSON schema from every Zod input schema', () => {
    for (const tool of canonryMcpTools) {
      expect(tool.inputSchema).toBeTruthy()
      expect(tool.inputJsonSchema).toMatchObject({ title: tool.name })
      const schema = tool.inputJsonSchema as { type?: string; anyOf?: unknown[]; oneOf?: unknown[] }
      // A discriminated action union is emitted as oneOf; every branch is
      // still a strict object and the no-$ref assertion below remains intact.
      expect(schema.type === 'object' || Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)).toBe(true)
      expect(tool.inputJsonSchema).not.toHaveProperty('$ref')
    }

    const projectSchema = inputSchemaFor('canonry_project_get')
    expect(projectSchema.required).toContain('project')
    expect(schemaProperty(projectSchema, 'project')).toMatchObject({
      type: 'string',
      minLength: 1,
      description: 'Canonry project name.',
    })
    expect(projectSchema.properties).not.toHaveProperty('sitemapIndex')

    const runTriggerRequest = schemaProperty(inputSchemaFor('canonry_run_trigger'), 'request')
    expect(schemaProperty(runTriggerRequest, 'kind')).toMatchObject({ const: 'answer-visibility' })
    // Operator-supplied triggers: 'manual' (default) or 'probe' (test runs
    // excluded from dashboard / analytics — see root AGENTS.md "Probe runs").
    expect(schemaProperty(runTriggerRequest, 'trigger')).toMatchObject({
      type: 'string',
      enum: ['manual', 'probe'],
    })
    expect(runTriggerRequest.required ?? []).not.toContain('kind')
    expect(runTriggerRequest.required ?? []).not.toContain('trigger')
    // Batch dispatch (#1201): the same optional field POST /projects/:name/runs takes.
    expect(schemaProperty(runTriggerRequest, 'dispatchMode')).toMatchObject({ type: 'string', enum: ['sync', 'batch'] })
    expect(runTriggerRequest.required ?? []).not.toContain('dispatchMode')
    // Account-failure admission override: optional, like every other run field.
    expect(schemaProperty(runTriggerRequest, 'force')).toMatchObject({ type: 'boolean' })
    expect(runTriggerRequest.required ?? []).not.toContain('force')
    const projectUpsertRequest = schemaProperty(inputSchemaFor('canonry_project_upsert'), 'request')
    expect(projectUpsertRequest.required ?? []).not.toContain('providerDispatchModes')
    expect(schemaProperty(projectUpsertRequest, 'providerDispatchModes')).toMatchObject({ type: 'object' })
    const applySpec = schemaProperty(schemaProperty(inputSchemaFor('canonry_apply_config'), 'config'), 'spec')
    expect(applySpec.required ?? []).not.toContain('providerDispatchModes')
    expect(schemaProperty(applySpec, 'providerDispatchModes')).toMatchObject({ type: 'object' })

    expect(schemaProperty(inputSchemaFor('canonry_runs_list'), 'limit')).toMatchObject({
      type: 'integer',
      maximum: 500,
    })
    expect(schemaProperty(inputSchemaFor('canonry_runs_list'), 'kind')).toMatchObject({ type: 'string' })
    expect(schemaProperty(inputSchemaFor('canonry_runs_list'), 'status')).toMatchObject({
      type: 'string',
      enum: ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled'],
    })

    const visibilityStatsSchema = inputSchemaFor('canonry_visibility_stats')
    expect(schemaProperty(visibilityStatsSchema, 'month')).toMatchObject({ type: 'string' })
    expect(schemaProperty(visibilityStatsSchema, 'shareOfVoice')).toMatchObject({ type: 'boolean' })

    const adsGeoSearch = canonryMcpTools.find(candidate => candidate.name === 'canonry_ads_geo_search')
    expect(adsGeoSearch?.inputSchema.parse({ project: 'acme', q: '  New York  ' })).toEqual({
      project: 'acme',
      q: 'New York',
      limit: 20,
    })
    expect(() => adsGeoSearch?.inputSchema.parse({ project: 'acme', q: 'New York', limit: 101 })).toThrow()

    const adsOperationsUnresolved = canonryMcpTools.find(
      candidate => candidate.name === 'canonry_ads_operations_unresolved',
    )
    expect(adsOperationsUnresolved?.inputSchema.parse({
      project: 'acme',
      state: ['unknown', 'pending'],
      limit: 25,
    })).toEqual({ project: 'acme', state: ['unknown', 'pending'], limit: 25 })
    expect(() => adsOperationsUnresolved?.inputSchema.parse({
      project: 'acme',
      state: ['succeeded'],
    })).toThrow()

    const adsOperationReconcile = canonryMcpTools.find(
      candidate => candidate.name === 'canonry_ads_operation_reconcile',
    )
    expect(adsOperationReconcile?.inputSchema.parse({
      project: 'acme',
      operationKey: 'weekend:campaign:pending',
    })).toEqual({
      project: 'acme',
      operationKey: 'weekend:campaign:pending',
    })
    expect(() => adsOperationReconcile?.inputSchema.parse({
      project: 'acme',
      operationKey: 'weekend:campaign:pending',
      candidateEntityId: 'cmpn_1',
    })).toThrow()

    const adsOperationResumeActivation = canonryMcpTools.find(
      candidate => candidate.name === 'canonry_ads_operation_resume_activation',
    )
    expect(adsOperationResumeActivation?.inputSchema.parse({
      project: 'acme',
      operationKey: 'weekend:campaign:activate:1',
    })).toEqual({
      project: 'acme',
      operationKey: 'weekend:campaign:activate:1',
    })
    expect(() => adsOperationResumeActivation?.inputSchema.parse({
      project: 'acme',
      operationKey: 'weekend:campaign:activate:1',
      grantId: 'grant_override',
    })).toThrow()

    const adsCampaignCreate = canonryMcpTools.find(
      candidate => candidate.name === 'canonry_ads_campaign_create',
    )
    const clickCampaign = {
      project: 'acme',
      request: {
        operationKey: 'weekend:campaign:clicks',
        name: 'AEO Audit Leads',
        lifetimeSpendLimitMicros: 25_000_000,
        locationIds: ['1000232'],
        biddingType: 'clicks',
        conversionEventSettingIds: ['cevent_audit_booked'],
      },
    }
    expect(adsCampaignCreate?.inputSchema.parse(clickCampaign)).toEqual(clickCampaign)
    // Click billing does not require conversion events: the campaign may carry
    // an empty list, or omit the field entirely.
    const clickCampaignNoEvents = {
      ...clickCampaign,
      request: { ...clickCampaign.request, conversionEventSettingIds: [] },
    }
    expect(adsCampaignCreate?.inputSchema.parse(clickCampaignNoEvents)).toEqual(clickCampaignNoEvents)
    const { conversionEventSettingIds: _omitted, ...clickRequestWithoutEvents } = clickCampaign.request
    const clickCampaignOmitted = { ...clickCampaign, request: clickRequestWithoutEvents }
    expect(adsCampaignCreate?.inputSchema.parse(clickCampaignOmitted)).toEqual(clickCampaignOmitted)
    expect(() => adsCampaignCreate?.inputSchema.parse({
      ...clickCampaign,
      request: { ...clickCampaign.request, conversionEventSettingIds: ['dupe', 'dupe'] },
    })).toThrow()

    const adsCampaignActivateTree = canonryMcpTools.find(
      candidate => candidate.name === 'canonry_ads_campaign_activate_tree',
    )
    const activation = {
      project: 'acme',
      campaignId: 'cmpn_approved',
      request: {
        operationKey: 'weekend:campaign:activate:1',
        grantId: 'grant_approved',
        manifestHash: 'a'.repeat(64),
      },
    }
    expect(adsCampaignActivateTree?.inputSchema.parse(activation)).toEqual(activation)
    expect(() => adsCampaignActivateTree?.inputSchema.parse({
      ...activation,
      request: { ...activation.request, manifestHash: 'not-a-hash' },
    })).toThrow()

    const adsAdGroupCreate = canonryMcpTools.find(
      candidate => candidate.name === 'canonry_ads_ad_group_create',
    )
    expect(adsAdGroupCreate?.inputSchema.parse({
      project: 'acme',
      request: {
        operationKey: 'weekend:group:clicks',
        campaignId: 'cmpn_clicks',
        name: 'AEO audit demand',
        contextHints: ['book an AEO audit'],
        maxBidMicros: 60_000,
        billingEventType: 'click',
      },
    })).toMatchObject({ request: { billingEventType: 'click' } })

    const measurementDiscovery = canonryMcpTools.find(
      candidate => candidate.name === 'canonry_measurement_discovery',
    )
    const discoveryInput = {
      project: 'acme',
      sitemapUrl: 'https://acme.example/sitemap.xml',
      rule: { primary: { host: 'acme.example', pathTemplate: '/locations/{slug}' } },
      maxUrls: 200,
    }
    expect(measurementDiscovery?.inputSchema.parse(discoveryInput)).toEqual(discoveryInput)
    expect(() => measurementDiscovery?.inputSchema.parse({ ...discoveryInput, maxUrls: 10_001 })).toThrow()
    expect(() => measurementDiscovery?.inputSchema.parse({ ...discoveryInput, unknown: true })).toThrow()

    const measurementOverview = canonryMcpTools.find(
      candidate => candidate.name === 'canonry_measurement_overview',
    )
    expect(measurementOverview).toMatchObject({ access: 'read', tier: 'setup' })
    expect(getCanonryMcpTools('read-only').map(tool => tool.name)).toContain('canonry_measurement_overview')
    expect(measurementOverview?.inputSchema.parse({
      project: 'acme',
      scope: 'property',
      targetKey: 'harbor-view',
      queryClass: 'non-brand',
      provider: 'openai',
      location: 'New York, NY',
      from: '2026-07-01',
      to: '2026-07-31',
      runId: 'run-7',
      search: 'harbor',
      cursor: 'next-page',
      limit: 100,
    })).toEqual({
      project: 'acme',
      scope: 'property',
      targetKey: 'harbor-view',
      queryClass: 'non-brand',
      provider: 'openai',
      location: 'New York, NY',
      from: '2026-07-01',
      to: '2026-07-31',
      runId: 'run-7',
      search: 'harbor',
      cursor: 'next-page',
      limit: 100,
      compact: true,
    })
    expect(() => measurementOverview?.inputSchema.parse({ project: 'acme', scope: 'all', limit: 101 })).toThrow()
    expect(() => measurementOverview?.inputSchema.parse({ project: 'acme', scope: 'property' })).toThrow()
    expect(() => measurementOverview?.inputSchema.parse({ project: 'acme', scope: 'group' })).toThrow()
    expect(() => measurementOverview?.inputSchema.parse({ project: 'acme', scope: 'all', groupKey: 'east' })).toThrow()
    expect(() => measurementOverview?.inputSchema.parse({ project: 'acme', scope: 'all', targetKey: 'harbor-view' })).toThrow()
    expect(() => measurementOverview?.inputSchema.parse({ project: 'acme', scope: 'group', groupKey: 'east', targetKey: 'harbor-view' })).toThrow()
    expect(() => measurementOverview?.inputSchema.parse({ project: 'acme', scope: 'property', targetKey: 'harbor-view', groupKey: 'east' })).toThrow()
  })

  it('limits MCP run trigger input to manual answer-visibility runs', () => {
    const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_run_trigger')
    expect(tool).toBeTruthy()

    expect(() => tool!.inputSchema.parse({ project: 'acme', request: { kind: 'ga-sync' } })).toThrow()
    expect(() => tool!.inputSchema.parse({ project: 'acme', request: { trigger: 'scheduled' } })).toThrow()
    expect(() => tool!.inputSchema.parse({ project: 'acme', request: { kind: 'answer-visibility', trigger: 'manual' } })).not.toThrow()
  })

  it('trims batch write strings before handlers receive them', () => {
    const queriesTool = canonryMcpTools.find(candidate => candidate.name === 'canonry_queries_add')
    const keywordsTool = canonryMcpTools.find(candidate => candidate.name === 'canonry_keywords_add')
    const competitorsTool = canonryMcpTools.find(candidate => candidate.name === 'canonry_competitors_add')
    expect(queriesTool).toBeTruthy()
    expect(keywordsTool).toBeTruthy()
    expect(competitorsTool).toBeTruthy()

    expect(queriesTool!.inputSchema.parse({ project: 'acme', request: { queries: [' alpha '] } })).toEqual({
      project: 'acme',
      request: { queries: ['alpha'] },
    })
    expect(() => queriesTool!.inputSchema.parse({ project: 'acme', request: { queries: ['  '] } })).toThrow()
    expect(keywordsTool!.inputSchema.parse({ project: 'acme', request: { keywords: [' alpha '] } })).toEqual({
      project: 'acme',
      request: { keywords: ['alpha'] },
    })
    expect(() => keywordsTool!.inputSchema.parse({ project: 'acme', request: { keywords: ['  '] } })).toThrow()
    expect(competitorsTool!.inputSchema.parse({ project: 'acme', request: { competitors: [' rival.example.com '] } })).toEqual({
      project: 'acme',
      request: { competitors: ['rival.example.com'] },
    })
    // The same body POST /competitors takes: a domain or { domain, aliases }.
    expect(competitorsTool!.inputSchema.parse({ project: 'acme', request: { competitors: [{ domain: ' qvx.example ', aliases: ['QVX'] }, 'rival.example.com'] } })).toEqual({
      project: 'acme',
      request: { competitors: [{ domain: 'qvx.example', aliases: ['QVX'] }, 'rival.example.com'] },
    })
  })

  it('creates one API client per MCP server instance', () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    let factoryCalls = 0
    createCanonryMcpServer({
      clientFactory: () => {
        factoryCalls += 1
        return makeClient(calls)
      },
    })

    expect(factoryCalls).toBe(1)
  })

  it('sets write annotations from the audit table', () => {
    const annotations = Object.fromEntries(
      canonryMcpTools
        .filter(tool => tool.access === 'write')
        .map(tool => [tool.name, tool.annotations]),
    )

    expect(annotations.canonry_run_trigger).toMatchObject({ idempotentHint: false, destructiveHint: false })
    expect(annotations.canonry_run_cancel).toMatchObject({ idempotentHint: false, destructiveHint: true })
    expect(annotations.canonry_project_upsert).toMatchObject({ idempotentHint: true, destructiveHint: true })
    expect(annotations.canonry_apply_config).toMatchObject({ idempotentHint: true, destructiveHint: true })
    expect(annotations.canonry_queries_generate).toMatchObject({ idempotentHint: false, destructiveHint: false })
    expect(annotations.canonry_queries_replace).toMatchObject({ idempotentHint: true, destructiveHint: true })
    expect(annotations.canonry_queries_add).toMatchObject({ idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_queries_remove).toMatchObject({ idempotentHint: true, destructiveHint: true })
    expect(annotations.canonry_keywords_generate).toMatchObject({ idempotentHint: false, destructiveHint: false })
    expect(annotations.canonry_keywords_replace).toMatchObject({ idempotentHint: true, destructiveHint: true })
    expect(annotations.canonry_keywords_add).toMatchObject({ idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_keywords_remove).toMatchObject({ idempotentHint: true, destructiveHint: true })
    expect(annotations.canonry_competitors_add).toMatchObject({ idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_competitors_remove).toMatchObject({ idempotentHint: true, destructiveHint: true })
    expect(annotations.canonry_competitors_aliases_set).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_competitors_auto_aliases_apply).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_competitors_aliases_block).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_competitors_aliases_unblock).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_schedule_set).toMatchObject({ idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_schedule_delete).toMatchObject({ idempotentHint: false, destructiveHint: true })
    expect(annotations.canonry_insight_dismiss).toMatchObject({ idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_agent_webhook_attach).toMatchObject({ idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_agent_webhook_detach).toMatchObject({ idempotentHint: true, destructiveHint: true })
    expect(annotations.canonry_measurement_discovery).toMatchObject({
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    })
    expect(annotations.canonry_ads_operation_resume_activation).toMatchObject({
      idempotentHint: true,
      destructiveHint: true,
      openWorldHint: true,
    })
    expect(annotations.canonry_gsc_sitemaps_submit).toMatchObject({ idempotentHint: false, destructiveHint: false, openWorldHint: true })
  })

  it('accepts exactly one sitemap submission branch', () => {
    const tool = canonryMcpTools.find((candidate) => candidate.name === 'canonry_gsc_sitemaps_submit')!
    expect(tool.inputSchema.safeParse({ project: 'acme', sitemapUrls: ['https://example.com/sitemap.xml'] }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ project: 'acme', mode: 'indexes' }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ project: 'acme', sitemapUrls: ['https://example.com/sitemap.xml'], mode: 'indexes' }).success).toBe(false)
  })

  it('classifies every OpenAPI operation for MCP coverage drift', () => {
    const doc = buildOpenApiDocument({ includeCanonryLocal: true })
    const operations = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.keys(methods as Record<string, unknown>).map(method => `${method.toUpperCase()} ${path}`),
    )

    expect(operations.sort()).toEqual(Object.keys(MCP_OPENAPI_OPERATION_CLASSIFICATIONS).sort())

    const referencedOperations = new Set(canonryMcpTools.flatMap(tool => tool.openApiOperations))
    const includedOperations = Object.entries(MCP_OPENAPI_OPERATION_CLASSIFICATIONS)
      .filter(([, classification]) => classification === 'included')
      .map(([operation]) => operation)

    expect([...referencedOperations].sort()).toEqual(includedOperations.sort())
  })

  it('routes paid research through the write client path', () => {
    const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_research_run_start')!
    expect(tool.access).toBe('write')
    expect(tool.openApiOperations).toEqual(['POST /api/v1/projects/{name}/research/runs'])
    expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS['POST /api/v1/projects/{name}/research/runs']).toBe('included')
    expect(tool.inputSchema.safeParse({
      project: 'acme',
      request: { queries: ['best AEO software'], provider: 'openai', scope: { kind: 'market', key: 'retail' }, template: { templateId: 'template-1', templateVersion: 'v3' } },
    }).success).toBe(true)
    expect(tool.inputSchema.safeParse({
      project: 'acme', request: { queries: ['best AEO software'], scope: { kind: 'group', key: 'retail' } },
    }).success).toBe(false)
    expect(tool.description).toMatch(/final free-form queries/i)
    expect(tool.description).toMatch(/Scope never changes query text/i)
  })

  it('exposes reviewed multi-destination research only through the write catalog', () => {
    const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_research_batch_start')!
    expect(tool).toMatchObject({ access: 'write', tier: 'discovery', annotations: { readOnlyHint: false, idempotentHint: true } })
    expect(getCanonryMcpTools('read-only').map(candidate => candidate.name)).not.toContain(tool.name)
    expect(tool.openApiOperations).toEqual(['POST /api/v1/projects/{name}/research/batches'])
    const run = { queries: ['Best apartments in Atlanta'], provider: 'openai', model: 'gpt-test', location: null, scope: { kind: 'market', key: 'atlanta', expectedPlanRevision: 3 } }
    expect(tool.inputSchema.safeParse({ project: 'acme', request: { idempotencyKey: 'reviewed-1', runs: [run] } }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ project: 'acme', request: { runs: [run] } }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ project: 'acme', request: { idempotencyKey: 'reviewed-1', runs: [{ ...run, scope: { kind: 'group', key: 'all' } }] } }).success).toBe(false)
  })

  it('maps Canonry client errors to isError tool results', async () => {
    const result = await withToolErrors(async () => {
      throw new CliError({
        code: 'VALIDATION_ERROR',
        message: 'bad input',
        details: { field: 'project' },
      })
    })

    expect(result.isError).toBe(true)
    const envelope = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'bad input',
        details: { field: 'project' },
      },
    }
    expect(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}')).toEqual(envelope)
    expect(result.structuredContent).toEqual(envelope)
  })

  it('keeps legacy JSON text while normalizing structured MCP results to objects', () => {
    const cases: Array<[unknown, unknown, unknown]> = [
      [{ project: 'acme' }, { project: 'acme' }, { project: 'acme' }],
      [[{ id: 'schedule-1' }], [{ id: 'schedule-1' }], { items: [{ id: 'schedule-1' }] }],
      ['enabled', 'enabled', { value: 'enabled' }],
      [0, 0, { value: 0 }],
      [null, null, { value: null }],
      [undefined, { ok: true }, { ok: true }],
    ]

    for (const [value, legacyText, structuredContent] of cases) {
      const result = jsonToolResult(value)
      expect(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}')).toEqual(legacyText)
      expect(result.structuredContent).toEqual(structuredContent)
    }
  })

  it('declares bounded output schemas for simple safe reads', () => {
    const cases: Array<[string, unknown, unknown]> = [
      ['canonry_settings_get', { providers: [], providerCatalog: [], google: { configured: false }, bing: { configured: false } }, { providers: [], providerCatalog: [], google: { configured: false }, bing: { configured: false } }],
      ['canonry_key_self', { id: 'key-1', name: 'agent', keyPrefix: 'cnry_test', scopes: ['read'], projectId: null, projectName: null, readOnly: true, createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, revokedAt: null }, { id: 'key-1', name: 'agent', keyPrefix: 'cnry_test', scopes: ['read'], projectId: null, projectName: null, readOnly: true, createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, revokedAt: null }],
      ['canonry_telemetry_get', { enabled: false, configuredEnabled: false, reason: 'configured_disabled' }, { enabled: false, configuredEnabled: false, reason: 'configured_disabled' }],
      ['canonry_schedules_list', [], { items: [] }],
      ['canonry_notification_events', ['run.completed'], { items: ['run.completed'] }],
    ]

    for (const [name, value, expectedStructuredContent] of cases) {
      const tool = canonryMcpTools.find(candidate => candidate.name === name)
      expect(tool, name).toBeDefined()
      expect(tool!.outputSchema, name).toBeDefined()
      const result = jsonToolResult(value)
      expect(result.structuredContent).toEqual(expectedStructuredContent)
      expect(tool!.outputSchema!.parse(result.structuredContent)).toEqual(expectedStructuredContent)
    }
  })

  it('maps ZodErrors to VALIDATION_ERROR envelopes', async () => {
    const schema = z.object({
      project: z.string().min(1),
      request: z.object({ queries: z.array(z.string()).min(1) }),
    })
    const result = await withToolErrors(async () => {
      schema.parse({ project: 'acme', request: { queries: [] } })
      return { ok: true }
    })

    expect(result.isError).toBe(true)
    const envelope = JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}') as {
      error: { code: string; message: string; details: { issues: Array<{ path: string; message: string }> } }
    }
    expect(envelope.error.code).toBe('VALIDATION_ERROR')
    expect(envelope.error.details.issues).toHaveLength(1)
    expect(envelope.error.details.issues[0]!.path).toBe('request.queries')
    expect(envelope.error.message).toContain('request.queries')
  })

  it('preserves API error details in MCP tool errors', async () => {
    const api = await startErrorApi()
    try {
      const client = new RealApiClient(api.origin, 'cnry_test', { skipProbe: true })
      const result = await withToolErrors(() => client.getProject('acme'))

      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}')).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'bad input',
          details: {
            field: 'project',
            reason: 'missing',
            httpStatus: 400,
          },
        },
      })
    } finally {
      await api.close()
    }
  })
})

describe('MCP tool handlers', () => {
  it('forwards every covered MCP input through the public HTTP client and returns its receipt', async () => {
    const fixture = await startNativeMcpDispatchFixture()
    try {
      const upstreamCases: NativeDispatchCase[] = [
        {
          caseId: 'main-feedback',
          tool: 'canonry_feedback',
          channel: 'mcp',
          input: { kind: 'struggle', summary: 'sweep fails on a free Gemini key' },
          requests: [{
            method: 'POST', path: '/native-mcp/api/v1/feedback', query: [],
            body: { kind: 'struggle', summary: 'sweep fails on a free Gemini key' },
            status: 202, response: { accepted: true, id: 'feedback-1' },
          }],
          expectedText: { accepted: true, id: 'feedback-1' },
          expectedStructured: { accepted: true, id: 'feedback-1' },
        },
        {
          caseId: 'main-traffic-analytics-period',
          tool: 'canonry_traffic_analytics',
          channel: 'mcp',
          input: { project: 'acme', period: 14 },
          requests: [{
            method: 'GET', path: '/native-mcp/api/v1/projects/acme/traffic/analytics',
            query: [['period', '14']], body: null, status: 200, response: { activity: null },
          }],
          expectedText: { activity: null },
          expectedStructured: { activity: null },
        },
        {
          caseId: 'main-traffic-analytics-default',
          tool: 'canonry_traffic_analytics',
          channel: 'mcp',
          input: { project: 'acme' },
          requests: [{
            method: 'GET', path: '/native-mcp/api/v1/projects/acme/traffic/analytics',
            query: [], body: null, status: 200, response: { activity: null },
          }],
          expectedText: { activity: null },
          expectedStructured: { activity: null },
        },
      ]
      for (const scenario of selectNativeDispatchCases([...registryDispatchCases, ...upstreamCases])) await fixture.verify(scenario)
    } finally {
      await fixture.close()
    }
  }, 20_000)

  it('preserves completed sitemap results when a later MCP batch is unconfirmed', async () => {
    const childUrls = Array.from({ length: 100 }, (_, index) => `https://example.com/child-${index}.xml`)
    let submitCalls = 0
    const client = {
      gscSitemaps: async (_project: string, params?: { sitemapIndex?: string }) => params?.sitemapIndex
        ? { sitemaps: childUrls.map((path) => ({ path })), preferredSubmissionUrls: [] }
        : {
            sitemaps: [{ path: 'https://example.com/index.xml', isSitemapsIndex: true }],
            preferredSubmissionUrls: ['https://example.com/index.xml'],
          },
      gscSubmitSitemaps: async (_project: string, body: { sitemapUrls: string[] }) => {
        submitCalls += 1
        if (submitCalls === 2) throw new Error('connection lost')
        return {
          summary: { total: body.sitemapUrls.length, accepted: body.sitemapUrls.length, failed: 0 },
          results: body.sitemapUrls.map((sitemapUrl) => ({ sitemapUrl, status: 'accepted' as const })),
        }
      },
    } as unknown as ApiClient
    const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_gsc_sitemaps_submit')!

    await expect(tool.handler(client, { project: 'acme', mode: 'all-files' })).rejects.toMatchObject({
      code: 'GOOGLE_SITEMAP_SUBMISSION_PARTIAL',
      details: {
        accepted: 50,
        failed: 0,
        completed: 50,
        attempted: 100,
        unconfirmed: 50,
        remaining: 0,
      },
    })
    expect(submitCalls).toBe(2)
  })
})

describe('Dynamic tool catalog', () => {
  it('disables non-core tools by default and enables them on toolkit load', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const { catalog } = createCanonryMcpServerWithCatalog({
      clientFactory: () => makeClient(calls),
    })

    const help = catalog.helpResult()
    expect(help.eager).toBe(false)
    expect(help.loadedToolkits).toEqual([])
    expect(help.coreTools).toEqual([
      'canonry_projects_list',
      'canonry_project_get',
      'canonry_project_overview',
      'canonry_search',
      'canonry_doctor',
      'canonry_settings_get',
      'canonry_key_self',
      'canonry_apply_config',
      'canonry_run_trigger',
      'canonry_feedback',
      'canonry_run_cancel',
      'canonry_agent_webhook_attach',
    ])
    expect(help.toolkits.map(t => t.name)).toEqual(['monitoring', 'setup', 'gsc', 'bing', 'ga', 'gbp', 'ads', 'google-ads', 'gtm', 'conversion-tracking', 'traffic', 'agent', 'discovery'])
    expect(help.toolkits.every(t => !t.loaded)).toBe(true)

    const monitoringFirst = catalog.loadToolkit('monitoring')
    expect(monitoringFirst.status).toBe('loaded')
    expect(monitoringFirst.tools).toContain('canonry_runs_latest')

    const monitoringSecond = catalog.loadToolkit('monitoring')
    expect(monitoringSecond.status).toBe('already-loaded')

    expect(() => catalog.loadToolkit('not-a-toolkit')).toThrow(/Unknown toolkit/)

    const refreshedHelp = catalog.helpResult()
    expect(refreshedHelp.loadedToolkits).toEqual(['monitoring'])
    expect(refreshedHelp.toolkits.find(t => t.name === 'monitoring')?.loaded).toBe(true)
  })

  it('respects --eager mode by marking every toolkit loaded', () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const { catalog } = createCanonryMcpServerWithCatalog({
      clientFactory: () => makeClient(calls),
      eager: true,
    })

    const help = catalog.helpResult()
    expect(help.eager).toBe(true)
    expect(help.loadedToolkits.sort()).toEqual(['ads', 'agent', 'bing', 'conversion-tracking', 'discovery', 'ga', 'gbp', 'google-ads', 'gsc', 'gtm', 'monitoring', 'setup', 'traffic'])
    expect(help.toolkits.every(t => t.loaded)).toBe(true)
  })

  it('loads conversion contracts from their cross-provider toolkit', () => {
    const { catalog } = createCanonryMcpServerWithCatalog({
      clientFactory: () => makeClient([]),
    })

    expect(catalog.loadToolkit('conversion-tracking').tools).toEqual([
      'canonry_conversion_tracking_contracts',
      'canonry_conversion_tracking_contract_get',
      'canonry_conversion_tracking_integrity',
    ])
  })

  it('still loads partial reads when read-only scope drops every write tool', () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const { catalog } = createCanonryMcpServerWithCatalog({
      clientFactory: () => makeClient(calls),
      scope: 'read-only',
    })

    // The agent toolkit has both reads (canonry_memory_list) and writes
    // (memory_set/forget, agent_clear, webhook_detach). In read-only scope
    // only the reads survive, so loading still reports `loaded` with the
    // surviving subset rather than `empty`.
    const result = catalog.loadToolkit('agent')
    expect(result.status).toBe('loaded')
    expect(result.tools).toEqual(['canonry_memory_list', 'canonry_agent_conversations_list', 'canonry_agent_conversations_get'])
  })

  it('emits exactly one tools/list_changed per loadToolkit batch', () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const { server, catalog } = createCanonryMcpServerWithCatalog({
      clientFactory: () => makeClient(calls),
    })

    let listChangedCount = 0
    const host = server as unknown as { sendToolListChanged(): void }
    const original = host.sendToolListChanged.bind(host)
    host.sendToolListChanged = () => {
      listChangedCount += 1
      original()
    }

    expect(catalog.loadToolkit('monitoring').status).toBe('loaded')
    expect(listChangedCount).toBe(1)

    expect(catalog.loadToolkit('monitoring').status).toBe('already-loaded')
    expect(listChangedCount).toBe(1)

    expect(catalog.loadToolkit('setup').status).toBe('loaded')
    expect(listChangedCount).toBe(2)
  })
})



function makeClient(calls: Array<{ method: string; args: unknown[] }>, fixture?: 'agent-notification'): ApiClient {
  const notifications = fixture === 'agent-notification'
    ? [{ id: 'notif-1', source: 'agent' }]
    : []
  const client = new Proxy({}, {
    get(_target, property) {
      return (...args: unknown[]) => {
        const method = String(property)
        calls.push({ method, args })
        if (method === 'listCompetitors') return [{ id: 'c1', domain: 'rival.example.com', createdAt: '2026-04-27T00:00:00Z' }]
        if (method === 'listNotifications') return notifications
        if (method === 'createNotification') return { id: 'notif-new', source: 'agent' }
        if (method === 'gscSitemaps') {
          const params = args[1] as { sitemapIndex?: string } | undefined
          return params?.sitemapIndex
            ? { sitemaps: [{ path: 'https://example.com/child.xml' }], summary: { total: 1, indexes: 0, files: 1 }, preferredSubmissionUrls: ['https://example.com/child.xml'] }
            : { sitemaps: [{ path: 'https://example.com/index.xml', isSitemapsIndex: true }], summary: { total: 1, indexes: 1, files: 0 }, preferredSubmissionUrls: ['https://example.com/index.xml'] }
        }
        if (method === 'gscSubmitSitemaps') {
          const urls = (args[1] as { sitemapUrls: string[] }).sitemapUrls
          return { summary: { total: urls.length, accepted: urls.length, failed: 0 }, results: [] }
        }
        return { ok: true, method }
      }
    },
  })
  return client as unknown as ApiClient
}

type JsonSchemaObject = {
  type?: string
  title?: string
  minLength?: number
  description?: string
  enum?: unknown[]
  const?: unknown
  maximum?: number
  required?: string[]
  properties?: Record<string, JsonSchemaObject>
}

function inputSchemaFor(name: string): JsonSchemaObject {
  const tool = canonryMcpTools.find(candidate => candidate.name === name)
  expect(tool).toBeTruthy()
  return tool!.inputJsonSchema as JsonSchemaObject
}

function schemaProperty(schema: JsonSchemaObject, key: string): JsonSchemaObject {
  const property = schema.properties?.[key]
  expect(property, key).toBeTruthy()
  return property!
}

async function startErrorApi(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((_request, response: ServerResponse) => {
    sendJson(response, {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'bad input',
        details: { field: 'project', reason: 'missing' },
      },
    }, 400)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to start stub API')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

async function startCaptureApi(): Promise<{
  origin: string
  requests: string[]
  close: () => Promise<void>
}> {
  const requests: string[] = []
  const server = createServer((request, response: ServerResponse) => {
    requests.push(request.url ?? '')
    sendJson(response, { mode: 'active-v2' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to start stub API')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

test('the run-trigger tool tells an agent it can measure one slice of a plan', () => {
  const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_run_trigger')!

  // The tool already accepts measurementScope; an agent that cannot see the
  // capability in the description will never reach for it.
  expect(tool.description).toMatch(/measurementScope/)
  expect(tool.description).toMatch(/group/i)
  expect(tool.description).toMatch(/target/i)
  // The description must not imply an empty scope is a way to ask for a sweep:
  // the API rejects that, and an agent following the text would get a 400.
  expect(tool.description).not.toMatch(/measurementScope=\{groups:\[\],\s*targets:\[\]\}/)
  expect(tool.description).toMatch(/omit the field/i)
})

describe('monthly comparison scope parity', () => {
  it('forwards the exact Property, market, provider and location selection through the existing read tool', async () => {
    const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_visibility_compare')!
    expect(tool.access).toBe('read')
    const fixture = await startNativeMcpDispatchFixture()
    try {
      for (const scenario of selectNativeDispatchCases(dedicatedDispatchCases, 'monthly-wire')) await fixture.verify(scenario)
    } finally {
      await fixture.close()
    }
  })
})
