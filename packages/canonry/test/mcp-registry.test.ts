import { createServer, type ServerResponse } from 'node:http'
import { describe, expect, it, test, vi } from 'vitest'
import { z } from 'zod'
import { buildOpenApiDocument } from '../../api-routes/src/openapi.js'
import { CliError } from '../src/cli-error.js'
import { ApiClient as RealApiClient, type ApiClient } from '../src/client.js'
import {
  CANONRY_MCP_CORE_TOOL_COUNT,
  CANONRY_MCP_READ_TOOL_COUNT,
  CANONRY_MCP_TOOL_COUNT,
  canonryMcpTools,
} from '../src/mcp/tool-registry.js'
import { MCP_OPENAPI_OPERATION_CLASSIFICATIONS } from '../src/mcp/openapi-classification.js'
import { createCanonryMcpServer, createCanonryMcpServerWithCatalog, getCanonryMcpTools } from '../src/mcp/server.js'
import { withToolErrors } from '../src/mcp/results.js'
import { CANONRY_MCP_TIERS, CANONRY_MCP_TOOLKITS } from '../src/mcp/toolkits.js'

const expectedToolNames = [
  'canonry_projects_list',
  'canonry_project_get',
  'canonry_project_delete_preview',
  'canonry_project_overview',
  'canonry_report',
  'canonry_organic_evidence',
  'canonry_analytics_metrics',
  'canonry_analytics_sources',
  'canonry_search',
  'canonry_doctor',
  'canonry_project_export',
  'canonry_project_history',
  'canonry_history_global',
  'canonry_runs_list',
  'canonry_runs_latest',
  'canonry_run_get',
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
  'canonry_content_brief',
  'canonry_content_map',
  'canonry_content_sources',
  'canonry_content_gaps',
  'canonry_queries_list',
  'canonry_keywords_list',
  'canonry_competitors_list',
  'canonry_schedule_get',
  'canonry_backlinks_latest_release',
  'canonry_backlinks_domains',
  'canonry_backlinks_sources',
  'canonry_settings_get',
  'canonry_google_connections_list',
  'canonry_gsc_performance',
  'canonry_gsc_performance_daily',
  'canonry_gsc_top_pages',
  'canonry_gsc_inspections',
  'canonry_gsc_deindexed',
  'canonry_gsc_coverage',
  'canonry_gsc_coverage_history',
  'canonry_gsc_sitemaps',
  'canonry_gsc_sitemaps_submit',
  'canonry_ga_status',
  'canonry_ga_properties',
  'canonry_ga_measurement_analysis',
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
  'canonry_gbp_summary',
  'canonry_traffic_sources_list',
  'canonry_traffic_source_get',
  'canonry_traffic_status',
  'canonry_traffic_events',
  'canonry_traffic_connect_cloud_run',
  'canonry_traffic_connect_wordpress',
  'canonry_traffic_connect_vercel',
  'canonry_traffic_sync',
  'canonry_traffic_backfill',
  'canonry_traffic_reset',
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
  'canonry_run_cancel',
  'canonry_queries_add',
  'canonry_keywords_add',
  'canonry_queries_remove',
  'canonry_keywords_remove',
  'canonry_competitors_add',
  'canonry_competitors_remove',
  'canonry_schedule_set',
  'canonry_schedule_delete',
  'canonry_insight_dismiss',
  'canonry_memory_list',
  'canonry_memory_set',
  'canonry_memory_forget',
  'canonry_agent_clear',
  'canonry_agent_webhook_attach',
  'canonry_agent_webhook_detach',
  'canonry_research_run_start',
  'canonry_research_runs_list',
  'canonry_research_run_get',
  'canonry_research_promotion_preview',
  'canonry_research_promotion_commit',
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
  it('defers Cloudflare connect to the local secret-safe CLI workflow', () => {
    expect(canonryMcpTools.some(tool => tool.name === 'canonry_traffic_connect_cloudflare')).toBe(false)
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
    expect(run.description).toContain('1,000 pages and 100,000 link observations')
    expect(run.inputSchema.safeParse({ project: 'acme', maxPages: 50_000, maxEdges: 1_000_000, maxDepth: 100, checkDeadLinks: true }).success).toBe(true)
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

  it('forwards measurement-plan inputs to the matching ApiClient methods', async () => {
    const client = {
      getMeasurementPlan: vi.fn().mockResolvedValue({ active: null }),
      listMeasurementPlanVersions: vi.fn().mockResolvedValue({ versions: [] }),
      getMeasurementPlanVersion: vi.fn().mockResolvedValue({ version: { revision: 2 } }),
      compileMeasurementPlanPreview: vi.fn().mockResolvedValue({ plan: {}, warnings: [], counts: {} }),
      diffMeasurementPlanPreview: vi.fn().mockResolvedValue({ plan: {}, warnings: [], counts: {}, diff: {} }),
      publishMeasurementPlan: vi.fn().mockResolvedValue({ active: { revision: 1 } }),
      retireMeasurementPlanSegment: vi.fn().mockResolvedValue({ stableKey: 'nyc' }),
      discoverMeasurementTargets: vi.fn().mockResolvedValue({ proposed: [] }),
      getMeasurementOverview: vi.fn().mockResolvedValue({ mode: 'active-v2' }),
      getMeasurementPropertyEvidence: vi.fn().mockResolvedValue({ evidence: { items: [], nextCursor: null } }),
      getMeasurementPortfolioSummary: vi.fn().mockResolvedValue({ properties: [] }),
      getMeasurementPropertyQuestions: vi.fn().mockResolvedValue({ questions: [] }),
      getMeasurementQuestionResult: vi.fn().mockResolvedValue({ answer: null }),
      getMeasurementPropertyCompetitors: vi.fn().mockResolvedValue({ competitors: [] }),
      getMeasurementChanges: vi.fn().mockResolvedValue({ comparison: { state: 'unavailable' } }),
      getMeasurementDataQuality: vi.fn().mockResolvedValue({ population: { state: 'no_population' } }),
      getMeasurementReport: vi.fn().mockResolvedValue({ revision: 2 }),
    } as unknown as ApiClient
    const plan = {
      schemaVersion: 1,
      targets: [{ stableKey: 'acme', label: 'Acme', urls: [{ kind: 'host', host: 'acme.com' }], aliases: [] }],
    }
    const cases = [
      ['canonry_measurement_plan_get', { project: 'acme' }, 'getMeasurementPlan', ['acme']],
      ['canonry_measurement_plan_versions', { project: 'acme' }, 'listMeasurementPlanVersions', ['acme']],
      ['canonry_measurement_plan_version_get', { project: 'acme', revision: 2 }, 'getMeasurementPlanVersion', ['acme', 2]],
      ['canonry_measurement_plan_compile_preview', { project: 'acme', plan }, 'compileMeasurementPlanPreview', ['acme', plan]],
      ['canonry_measurement_plan_diff_preview', { project: 'acme', plan }, 'diffMeasurementPlanPreview', ['acme', plan]],
      [
        'canonry_measurement_plan_publish',
        { project: 'acme', expectedActiveRevision: null, plan },
        'publishMeasurementPlan',
        ['acme', { expectedActiveRevision: null, plan }],
      ],
      ['canonry_measurement_plan_segment_retire', { project: 'acme', stableKey: 'nyc' }, 'retireMeasurementPlanSegment', ['acme', 'nyc']],
      ['canonry_measurement_discovery', {
        project: 'acme',
        sitemapUrl: 'https://acme.example/sitemap.xml',
        rule: { primary: { host: 'acme.example', pathTemplate: '/locations/{slug}' } },
        maxUrls: 250,
      }, 'discoverMeasurementTargets', ['acme', {
        sitemapUrl: 'https://acme.example/sitemap.xml',
        rule: { primary: { host: 'acme.example', pathTemplate: '/locations/{slug}' } },
        maxUrls: 250,
      }]],
      ['canonry_measurement_overview', {
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
        limit: 25,
      }, 'getMeasurementOverview', ['acme', {
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
      }]],
      ['canonry_measurement_property_evidence', {
        project: 'acme',
        targetKey: 'harbor-view',
        queryClass: 'branded',
        provider: 'openai',
        location: 'New York, NY',
        runId: 'run-7',
        shape: 'answers',
        cursor: 'next-page',
        limit: 25,
      }, 'getMeasurementPropertyEvidence', ['acme', {
        targetKey: 'harbor-view',
        queryClass: 'branded',
        provider: 'openai',
        location: 'New York, NY',
        runId: 'run-7',
        shape: 'answers',
        cursor: 'next-page',
        limit: 25,
      }]],
      ['canonry_measurement_portfolio_summary', {
        project: 'acme', groupKey: 'metro-east', queryClass: 'non-brand', provider: 'openai',
        location: 'New York, NY', runId: 'run-7', limit: 8,
      }, 'getMeasurementPortfolioSummary', ['acme', {
        groupKey: 'metro-east', queryClass: 'non-brand', provider: 'openai',
        location: 'New York, NY', runId: 'run-7', limit: 8,
      }]],
      ['canonry_measurement_property_questions', {
        project: 'acme', targetKey: 'harbor-view', queryClass: 'non-brand', provider: 'openai',
        location: 'New York, NY', runId: 'run-7', limit: 25,
      }, 'getMeasurementPropertyQuestions', ['acme', {
        targetKey: 'harbor-view', queryClass: 'non-brand', provider: 'openai',
        location: 'New York, NY', runId: 'run-7', limit: 25,
      }]],
      ['canonry_measurement_question_result', {
        project: 'acme', targetKey: 'harbor-view', resultId: 'result-7',
      }, 'getMeasurementQuestionResult', ['acme', { targetKey: 'harbor-view', resultId: 'result-7' }]],
      ['canonry_measurement_property_competitors', {
        project: 'acme', targetKey: 'harbor-view', queryClass: 'non-brand', provider: 'openai',
        location: 'New York, NY', runId: 'run-7', limit: 10,
      }, 'getMeasurementPropertyCompetitors', ['acme', {
        targetKey: 'harbor-view', queryClass: 'non-brand', provider: 'openai',
        location: 'New York, NY', runId: 'run-7', limit: 10,
      }]],
      ['canonry_measurement_changes', {
        project: 'acme', scope: 'group', groupKey: 'metro-east', queryClass: 'non-brand',
        provider: 'openai', location: 'New York, NY', runId: 'run-7', limit: 10,
      }, 'getMeasurementChanges', ['acme', {
        scope: 'group', groupKey: 'metro-east', queryClass: 'non-brand', provider: 'openai',
        location: 'New York, NY', runId: 'run-7', limit: 10,
      }]],
      ['canonry_measurement_data_quality', {
        project: 'acme', runId: 'run-7',
      }, 'getMeasurementDataQuality', ['acme', { runId: 'run-7' }]],
      ['canonry_measurement_report', {
        project: 'acme',
        revision: 2,
        runId: 'run-7',
      }, 'getMeasurementReport', ['acme', 2, 'run-7']],
    ] as const

    for (const [name, input, method, args] of cases) {
      const tool = canonryMcpTools.find(candidate => candidate.name === name)
      expect(tool, name).toBeTruthy()
      await tool!.handler(client, input)
      expect(client[method as keyof typeof client]).toHaveBeenCalledWith(...args)
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
    expect(CANONRY_MCP_TOOL_COUNT).toBe(208)
    expect(CANONRY_MCP_READ_TOOL_COUNT).toBe(140)
    expect(canonryMcpTools.map(tool => tool.name)).toEqual(expectedToolNames)
    const readNames = canonryMcpTools.filter(tool => tool.access === 'read').map(tool => tool.name)
    expect(getCanonryMcpTools('read-only').map(tool => tool.name)).toEqual(readNames)
  })

  it('keeps research promotion preview write-classified because its transport is POST', () => {
    const operation = 'POST /api/v1/projects/{name}/research/runs/{runId}/queries/{queryId}/promotion-preview'
    expect(canonryMcpTools.find(tool => tool.name === 'canonry_research_promotion_preview')).toMatchObject({
      access: 'write',
      tier: 'discovery',
      annotations: { readOnlyHint: false, idempotentHint: true },
      openApiOperations: [operation],
    })
    expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS[operation]).toBe('included')
    expect(getCanonryMcpTools('read-only').some(tool => tool.name === 'canonry_research_promotion_preview')).toBe(false)
  })

  it('exposes checksum-guarded research promotion commit as an idempotent write', () => {
    const operation = 'POST /api/v1/projects/{name}/research/runs/{runId}/queries/{queryId}/promotion'
    expect(canonryMcpTools.find(tool => tool.name === 'canonry_research_promotion_commit')).toMatchObject({
      access: 'write',
      tier: 'discovery',
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      openApiOperations: [operation],
    })
    expect(canonryMcpTools.find(tool => tool.name === 'canonry_research_promotion_commit')?.description)
      .toContain('already-tracked')
    expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS[operation]).toBe('included')
    expect(getCanonryMcpTools('read-only').some(tool => tool.name === 'canonry_research_promotion_commit')).toBe(false)
  })

  it('tags every tool with a tier from the published list', () => {
    for (const tool of canonryMcpTools) {
      expect(CANONRY_MCP_TIERS).toContain(tool.tier)
    }
    expect(CANONRY_MCP_CORE_TOOL_COUNT).toBe(10)
    const coreNames = canonryMcpTools.filter(tool => tool.tier === 'core').map(tool => tool.name)
    expect(coreNames).toEqual([
      'canonry_projects_list',
      'canonry_project_get',
      'canonry_project_overview',
      'canonry_search',
      'canonry_doctor',
      'canonry_settings_get',
      'canonry_apply_config',
      'canonry_run_trigger',
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
    expect(counts.get('monitoring')).toBe(45)
    expect(counts.get('setup')).toBe(51)
    expect(counts.get('gsc')).toBe(10)
    expect(counts.get('ga')).toBe(11)
    expect(counts.get('gbp')).toBe(13)
    expect(counts.get('ads')).toBe(26)
    expect(counts.get('google-ads')).toBe(6)
    expect(counts.get('gtm')).toBe(7)
    expect(counts.get('conversion-tracking')).toBe(3)
    expect(counts.get('traffic')).toBe(10)
    expect(counts.get('agent')).toBe(5)
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

    expect(schemaProperty(inputSchemaFor('canonry_runs_list'), 'limit')).toMatchObject({
      type: 'integer',
      maximum: 500,
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
    expect(() => adsCampaignCreate?.inputSchema.parse({
      ...clickCampaign,
      request: { ...clickCampaign.request, conversionEventSettingIds: [] },
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

  it('maps Canonry client errors to isError tool results', async () => {
    const result = await withToolErrors(async () => {
      throw new CliError({
        code: 'VALIDATION_ERROR',
        message: 'bad input',
        details: { field: 'project' },
      })
    })

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}')).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'bad input',
        details: { field: 'project' },
      },
    })
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
  it('calls the expected ApiClient method for every tool', async () => {
    for (const testCase of handlerCases) {
      const calls: Array<{ method: string; args: unknown[] }> = []
      const client = makeClient(calls, testCase.fixture)
      const tool = canonryMcpTools.find(candidate => candidate.name === testCase.tool)
      expect(tool, testCase.tool).toBeTruthy()
      await tool!.handler(client, testCase.input)
      expect(calls.map(call => call.method)).toEqual(testCase.methods)
      if (testCase.expectedArgs) {
        expect(calls.map(call => call.args)).toEqual(testCase.expectedArgs)
      }
    }
  })

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
      'canonry_apply_config',
      'canonry_run_trigger',
      'canonry_run_cancel',
      'canonry_agent_webhook_attach',
    ])
    expect(help.toolkits.map(t => t.name)).toEqual(['monitoring', 'setup', 'gsc', 'ga', 'gbp', 'ads', 'google-ads', 'gtm', 'conversion-tracking', 'traffic', 'agent', 'discovery'])
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
    expect(help.loadedToolkits.sort()).toEqual(['ads', 'agent', 'conversion-tracking', 'discovery', 'ga', 'gbp', 'google-ads', 'gsc', 'gtm', 'monitoring', 'setup', 'traffic'])
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
    expect(result.tools).toEqual(['canonry_memory_list'])
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

type HandlerCase = {
  tool: string
  input: Record<string, unknown>
  methods: string[]
  expectedArgs?: unknown[][]
  fixture?: 'agent-notification'
}

const projectInput = { project: 'acme' }

const handlerCases: HandlerCase[] = [
  { tool: 'canonry_projects_list', input: {}, methods: ['listProjects'] },
  { tool: 'canonry_project_get', input: projectInput, methods: ['getProject'] },
  { tool: 'canonry_project_overview', input: projectInput, methods: ['getProjectOverview'] },
  { tool: 'canonry_analytics_metrics', input: { project: 'acme', window: '30d' }, methods: ['getAnalyticsMetrics'] },
  { tool: 'canonry_search', input: { project: 'acme', q: 'rival' }, methods: ['searchProject'] },
  { tool: 'canonry_project_export', input: projectInput, methods: ['getExport'] },
  {
    tool: 'canonry_project_history',
    input: projectInput,
    methods: ['getHistory'],
    expectedArgs: [['acme', { limit: undefined, offset: undefined, since: undefined, action: undefined, actor: undefined, entityType: undefined }]],
  },
  { tool: 'canonry_history_global', input: { limit: 50 }, methods: ['getGlobalHistory'], expectedArgs: [[{ limit: 50 }]] },
  { tool: 'canonry_runs_list', input: { project: 'acme', limit: 5 }, methods: ['listRuns'] },
  { tool: 'canonry_runs_latest', input: projectInput, methods: ['getLatestRun'] },
  { tool: 'canonry_run_get', input: { runId: 'run-1' }, methods: ['getRun'] },
  {
    tool: 'canonry_timeline_get',
    input: { project: 'acme', location: 'nyc', limit: 20 },
    methods: ['getTimeline'],
    expectedArgs: [['acme', 'nyc', 20]],
  },
  {
    tool: 'canonry_visibility_stats',
    input: { project: 'acme', month: '2026-06', groupBy: 'provider', shareOfVoice: true },
    methods: ['getVisibilityStats'],
    expectedArgs: [[
      'acme',
      {
        since: undefined,
        until: undefined,
        lastRuns: undefined,
        groupBy: 'provider',
        month: '2026-06',
        shareOfVoice: true,
      },
    ]],
  },
  { tool: 'canonry_snapshots_list', input: { project: 'acme', limit: 5 }, methods: ['getSnapshots'] },
  { tool: 'canonry_snapshots_diff', input: { project: 'acme', run1: 'run-1', run2: 'run-2' }, methods: ['getSnapshotDiff'] },
  { tool: 'canonry_insights_list', input: { project: 'acme', dismissed: true }, methods: ['getInsights'] },
  { tool: 'canonry_insight_get', input: { project: 'acme', insightId: 'insight-1' }, methods: ['getInsight'] },
  { tool: 'canonry_health_latest', input: projectInput, methods: ['getHealth'] },
  { tool: 'canonry_health_history', input: { project: 'acme', limit: 10 }, methods: ['getHealthHistory'] },
  { tool: 'canonry_queries_list', input: projectInput, methods: ['listQueries'] },
  { tool: 'canonry_keywords_list', input: projectInput, methods: ['listKeywords'] },
  { tool: 'canonry_competitors_list', input: projectInput, methods: ['listCompetitors'] },
  { tool: 'canonry_schedule_get', input: { project: 'acme', kind: 'traffic-sync' }, methods: ['getSchedule'], expectedArgs: [['acme', 'traffic-sync']] },
  { tool: 'canonry_schedule_get', input: projectInput, methods: ['getSchedule'], expectedArgs: [['acme', undefined]] },
  { tool: 'canonry_backlinks_latest_release', input: {}, methods: ['backlinksLatestRelease'] },
  { tool: 'canonry_settings_get', input: {}, methods: ['getSettings'] },
  { tool: 'canonry_google_connections_list', input: projectInput, methods: ['googleConnections'] },
  { tool: 'canonry_gsc_performance', input: { project: 'acme', window: '30d' }, methods: ['gscPerformance'] },
  { tool: 'canonry_gsc_performance_daily', input: { project: 'acme', window: '30d' }, methods: ['gscPerformanceDaily'] },
  { tool: 'canonry_gsc_inspections', input: { project: 'acme', limit: 5 }, methods: ['gscInspections'] },
  { tool: 'canonry_gsc_deindexed', input: projectInput, methods: ['gscDeindexed'] },
  { tool: 'canonry_gsc_coverage', input: projectInput, methods: ['gscCoverage'] },
  { tool: 'canonry_gsc_coverage_history', input: { project: 'acme', limit: 5 }, methods: ['gscCoverageHistory'] },
  { tool: 'canonry_gsc_sitemaps', input: projectInput, methods: ['gscSitemaps'], expectedArgs: [['acme', { sitemapIndex: undefined }]] },
  {
    tool: 'canonry_gsc_sitemaps_submit',
    input: { project: 'acme', sitemapUrls: ['https://example.com/sitemap.xml'] },
    methods: ['gscSubmitSitemaps'],
    expectedArgs: [['acme', { sitemapUrls: ['https://example.com/sitemap.xml'] }]],
  },
  {
    tool: 'canonry_gsc_sitemaps_submit',
    input: { project: 'acme', mode: 'indexes' },
    methods: ['gscSitemaps', 'gscSubmitSitemaps'],
    expectedArgs: [['acme'], ['acme', { sitemapUrls: ['https://example.com/index.xml'] }]],
  },
  {
    tool: 'canonry_gsc_sitemaps_submit',
    input: { project: 'acme', mode: 'all-files' },
    methods: ['gscSitemaps', 'gscSitemaps', 'gscSubmitSitemaps'],
    expectedArgs: [
      ['acme'],
      ['acme', { sitemapIndex: 'https://example.com/index.xml' }],
      ['acme', { sitemapUrls: ['https://example.com/child.xml'] }],
    ],
  },
  { tool: 'canonry_ga_status', input: projectInput, methods: ['gaStatus'] },
  {
    tool: 'canonry_ga_measurement_analysis',
    input: { project: 'acme', window: '90d', hostScope: 'marketing', pathPrefix: '/blog', limit: 5 },
    methods: ['gaMeasurementAnalysis'],
  },
  { tool: 'canonry_ga_traffic', input: { project: 'acme', limit: 5 }, methods: ['gaTraffic'] },
  { tool: 'canonry_ga_coverage', input: projectInput, methods: ['gaCoverage'] },
  { tool: 'canonry_ga_ai_referral_history', input: { project: 'acme', window: '7d' }, methods: ['gaAiReferralHistory'] },
  { tool: 'canonry_ga_social_referral_history', input: { project: 'acme', window: '7d' }, methods: ['gaSocialReferralHistory'] },
  { tool: 'canonry_ga_social_referral_trend', input: projectInput, methods: ['gaSocialReferralTrend'] },
  { tool: 'canonry_ga_attribution_trend', input: projectInput, methods: ['gaAttributionTrend'] },
  { tool: 'canonry_ga_session_history', input: { project: 'acme', window: '7d' }, methods: ['gaSessionHistory'] },
  { tool: 'canonry_ads_account', input: projectInput, methods: ['getAdsAccount'] },
  {
    tool: 'canonry_ads_geo_search',
    input: { project: 'acme', q: 'New York', limit: 20 },
    methods: ['searchAdsGeo'],
    expectedArgs: [['acme', { q: 'New York', limit: 20 }]],
  },
  { tool: 'canonry_ads_conversion_pixels', input: projectInput, methods: ['getAdsConversionPixels'] },
  { tool: 'canonry_ads_conversion_event_settings', input: projectInput, methods: ['getAdsConversionEventSettings'] },
  {
    tool: 'canonry_ads_operations_unresolved',
    input: {
      project: 'acme',
      state: ['pending', 'unknown', 'reconciling'],
      limit: 100,
      cursor: 'next-page',
    },
    methods: ['getUnresolvedAdsOperations'],
    expectedArgs: [[
      'acme',
      { state: ['pending', 'unknown', 'reconciling'], limit: 100, cursor: 'next-page' },
    ]],
  },
  {
    tool: 'canonry_ads_operation_reconcile',
    input: { project: 'acme', operationKey: 'weekend:campaign:pending' },
    methods: ['reconcileAdsOperation'],
    expectedArgs: [['acme', 'weekend:campaign:pending']],
  },
  {
    tool: 'canonry_ads_operation_resume_activation',
    input: { project: 'acme', operationKey: 'weekend:campaign:activate:1' },
    methods: ['resumeAdsActivation'],
    expectedArgs: [['acme', 'weekend:campaign:activate:1']],
  },
  {
    tool: 'canonry_ads_campaign_activate_tree',
    input: {
      project: 'acme',
      campaignId: 'cmpn_approved',
      request: {
        operationKey: 'weekend:campaign:activate:1',
        grantId: 'grant_approved',
        manifestHash: 'a'.repeat(64),
      },
    },
    methods: ['activateAdsCampaignTree'],
    expectedArgs: [[
      'acme',
      'cmpn_approved',
      {
        operationKey: 'weekend:campaign:activate:1',
        grantId: 'grant_approved',
        manifestHash: 'a'.repeat(64),
      },
    ]],
  },
  { tool: 'canonry_traffic_sources_list', input: projectInput, methods: ['trafficListSources'] },
  { tool: 'canonry_traffic_source_get', input: { project: 'acme', sourceId: 'src-1' }, methods: ['trafficGetSource'] },
  { tool: 'canonry_traffic_status', input: projectInput, methods: ['trafficStatus'] },
  {
    tool: 'canonry_traffic_events',
    input: { project: 'acme', kind: 'crawler', limit: 50, granularity: 'day' },
    methods: ['trafficListEvents'],
    expectedArgs: [['acme', { kind: 'crawler', limit: 50, granularity: 'day' }]],
  },
  {
    tool: 'canonry_traffic_connect_cloud_run',
    input: {
      project: 'acme',
      request: {
        gcpProjectId: 'gcp-acme',
        serviceName: 'web',
        keyJson: '{"client_email":"sa@gcp-acme.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\\nstub\\n-----END PRIVATE KEY-----\\n"}',
      },
    },
    methods: ['trafficConnectCloudRun'],
  },
  {
    tool: 'canonry_traffic_connect_vercel',
    input: {
      project: 'acme',
      request: {
        projectId: 'prj_abc',
        teamId: 'team_xyz',
        token: 'vcp_test_token',
      },
    },
    methods: ['trafficConnectVercel'],
  },
  {
    tool: 'canonry_traffic_sync',
    input: { project: 'acme', sourceId: 'src-1', sinceMinutes: 120 },
    methods: ['trafficSync'],
  },
  {
    tool: 'canonry_project_upsert',
    input: {
      project: 'acme',
      request: {
        displayName: 'Acme',
        canonicalDomain: 'acme.example.com',
        country: 'US',
        language: 'en',
      },
    },
    methods: ['putProject'],
  },
  {
    tool: 'canonry_apply_config',
    input: {
      config: {
        apiVersion: 'canonry/v1',
        kind: 'Project',
        metadata: { name: 'acme' },
        spec: {
          displayName: 'Acme',
          canonicalDomain: 'acme.example.com',
          country: 'US',
          language: 'en',
        },
      },
    },
    methods: ['apply'],
  },
  { tool: 'canonry_queries_generate', input: { project: 'acme', request: { provider: 'gemini', count: 3 } }, methods: ['generateQueries'] },
  { tool: 'canonry_keywords_generate', input: { project: 'acme', request: { provider: 'gemini', count: 3 } }, methods: ['generateKeywords'] },
  { tool: 'canonry_queries_replace', input: { project: 'acme', request: { queries: ['alpha'] } }, methods: ['putQueries'] },
  { tool: 'canonry_queries_replace_preview', input: { project: 'acme', request: { queries: ['alpha'] } }, methods: ['previewReplaceQueries'] },
  { tool: 'canonry_keywords_replace', input: { project: 'acme', request: { keywords: ['alpha'] } }, methods: ['putKeywords'] },
  { tool: 'canonry_run_trigger', input: { project: 'acme', request: { providers: ['gemini'] } }, methods: ['triggerRun'] },
  { tool: 'canonry_run_cancel', input: { runId: 'run-1' }, methods: ['cancelRun'] },
  { tool: 'canonry_queries_add', input: { project: 'acme', request: { queries: ['alpha'] } }, methods: ['appendQueries'] },
  { tool: 'canonry_keywords_add', input: { project: 'acme', request: { keywords: ['alpha'] } }, methods: ['appendKeywords'] },
  { tool: 'canonry_queries_remove', input: { project: 'acme', request: { queries: ['alpha'] } }, methods: ['deleteQueries'] },
  { tool: 'canonry_keywords_remove', input: { project: 'acme', request: { keywords: ['alpha'] } }, methods: ['deleteKeywords'] },
  { tool: 'canonry_competitors_add', input: { project: 'acme', request: { competitors: ['other.example.com'] } }, methods: ['appendCompetitors'] },
  { tool: 'canonry_competitors_remove', input: { project: 'acme', request: { competitors: ['other.example.com'] } }, methods: ['deleteCompetitors'] },
  { tool: 'canonry_schedule_set', input: { project: 'acme', schedule: { preset: 'daily', timezone: 'UTC' } }, methods: ['putSchedule'] },
  { tool: 'canonry_schedule_delete', input: { project: 'acme', kind: 'traffic-sync' }, methods: ['deleteSchedule'], expectedArgs: [['acme', 'traffic-sync']] },
  { tool: 'canonry_schedule_delete', input: projectInput, methods: ['deleteSchedule'], expectedArgs: [['acme', undefined]] },
  { tool: 'canonry_insight_dismiss', input: { project: 'acme', insightId: 'insight-1' }, methods: ['dismissInsight'] },
  { tool: 'canonry_content_targets', input: { project: 'acme', limit: 5 }, methods: ['getContentTargets'] },
  { tool: 'canonry_content_brief', input: { project: 'acme', targetRef: 'tgt_1' }, methods: ['synthesizeContentBrief'], expectedArgs: [['acme', 'tgt_1', { provider: undefined, model: undefined, forceRefresh: undefined }]] },
  { tool: 'canonry_content_map', input: projectInput, methods: ['getDomainClassifications'] },
  { tool: 'canonry_content_sources', input: projectInput, methods: ['getContentSources'] },
  { tool: 'canonry_content_gaps', input: projectInput, methods: ['getContentGaps'] },
  { tool: 'canonry_backlinks_domains', input: { project: 'acme', limit: 50 }, methods: ['backlinksDomains'] },
  { tool: 'canonry_backlinks_sources', input: { project: 'acme' }, methods: ['backlinksSources'] },
  { tool: 'canonry_memory_list', input: projectInput, methods: ['listAgentMemory'] },
  { tool: 'canonry_memory_set', input: { project: 'acme', key: 'pref', value: 'note' }, methods: ['setAgentMemory'] },
  { tool: 'canonry_memory_forget', input: { project: 'acme', key: 'pref' }, methods: ['forgetAgentMemory'] },
  { tool: 'canonry_agent_clear', input: projectInput, methods: ['resetAgentTranscript'] },
  { tool: 'canonry_agent_webhook_attach', input: { project: 'acme', url: 'https://agent.example.com/hook' }, methods: ['listNotifications', 'createNotification'] },
  { tool: 'canonry_agent_webhook_detach', input: projectInput, methods: ['listNotifications', 'deleteNotification'], fixture: 'agent-notification' },
  { tool: 'canonry_research_run_start', input: { project: 'acme', request: { queries: ['best AEO software'], provider: 'openai' } }, methods: ['startResearchRun'] },
  { tool: 'canonry_research_runs_list', input: { project: 'acme', limit: 5 }, methods: ['listResearchRuns'] },
  { tool: 'canonry_research_run_get', input: { project: 'acme', runId: 'research-1' }, methods: ['getResearchRun'] },
  { tool: 'canonry_research_promotion_preview', input: { project: 'acme', runId: 'research-1', queryId: 'query-1', request: { targetKeys: ['target-a'], groupKeys: ['group-a'], queryClass: 'non-brand' } }, methods: ['previewResearchPromotion'] },
  { tool: 'canonry_research_promotion_commit', input: { project: 'acme', runId: 'research-1', queryId: 'query-1', request: { previewChecksum: 'a'.repeat(64), request: { targetKeys: ['target-a'], queryClass: 'non-brand' } }, idempotencyKey: 'replay-1' }, methods: ['commitResearchPromotion'], expectedArgs: [['acme', 'research-1', 'query-1', { previewChecksum: 'a'.repeat(64), request: { targetKeys: ['target-a'], queryClass: 'non-brand' } }, 'replay-1']] },
  { tool: 'canonry_discover_run_start', input: { project: 'acme', request: { icpDescription: 'AEO analyst tool' } }, methods: ['triggerDiscoveryRun'] },
  { tool: 'canonry_discover_sessions_list', input: { project: 'acme', limit: 5 }, methods: ['listDiscoverySessions'] },
  { tool: 'canonry_discover_session_get', input: { project: 'acme', sessionId: 'sess-1' }, methods: ['getDiscoverySession'] },
  { tool: 'canonry_discover_harvest', input: { project: 'acme', sessionId: 'sess-1' }, methods: ['getDiscoveryHarvest'] },
  { tool: 'canonry_discover_promote_preview', input: { project: 'acme', sessionId: 'sess-1' }, methods: ['previewDiscoveryPromote'] },
  { tool: 'canonry_discover_promote', input: { project: 'acme', sessionId: 'sess-1' }, methods: ['promoteDiscovery'] },
  { tool: 'canonry_site_health_overview', input: { project: 'acme', runId: 'run-1' }, methods: ['getTechnicalAeoCrawl'], expectedArgs: [['acme', { runId: 'run-1' }]] },
  {
    tool: 'canonry_site_health_page_audit',
    input: { project: 'acme', runId: 'run-1', nodeKey: 'page:root' },
    methods: ['getTechnicalAeoPageAudit'],
    expectedArgs: [['acme', { runId: 'run-1', nodeKey: 'page:root', url: undefined }]],
  },
  {
    tool: 'canonry_site_health_subgraph',
    input: { project: 'acme', nodeKey: 'page:root', hops: 2 },
    methods: ['getSiteHealthSubgraph'],
    expectedArgs: [['acme', { runId: undefined, nodeKey: 'page:root', url: undefined, hops: 2, maxNodes: undefined, maxEdges: undefined }]],
  },
  {
    tool: 'canonry_site_health_path',
    input: { project: 'acme', fromNodeKey: 'page:root', toUrl: 'https://acme.test/pricing', maxDepth: 8 },
    methods: ['getSiteHealthPath'],
    expectedArgs: [['acme', { runId: undefined, fromNodeKey: 'page:root', fromUrl: undefined, toNodeKey: undefined, toUrl: 'https://acme.test/pricing', maxDepth: 8 }]],
  },
  {
    tool: 'canonry_site_health_changes',
    input: { project: 'acme', fromRunId: 'run-1', toRunId: 'run-2', scope: 'pages', change: 'changed', cursor: 'changes-2', limit: 25 },
    methods: ['getSiteHealthChanges'],
    expectedArgs: [['acme', { fromRunId: 'run-1', toRunId: 'run-2', scope: 'pages', change: 'changed', cursor: 'changes-2', limit: 25 }]],
  },
  { tool: 'canonry_technical_aeo_crawl', input: { project: 'acme', runId: 'run-1' }, methods: ['getTechnicalAeoCrawl'], expectedArgs: [['acme', { runId: 'run-1' }]] },
  {
    tool: 'canonry_technical_aeo_crawl_pages',
    input: { project: 'acme', runId: 'run-1', inventoryEligible: true, fetchState: 'html', indexabilityState: 'indexable', auditState: 'success', sort: 'score-asc', cursor: 'page-2', limit: 25 },
    methods: ['getTechnicalAeoCrawlPages'],
    expectedArgs: [['acme', { runId: 'run-1', inventoryEligible: true, fetchState: 'html', indexabilityState: 'indexable', auditState: 'success', sort: 'score-asc', cursor: 'page-2', limit: 25 }]],
  },
  {
    tool: 'canonry_technical_aeo_structure',
    input: { project: 'acme', runId: 'run-1', parentPath: '/guides', cursor: 'page-2', limit: 25 },
    methods: ['getTechnicalAeoStructure'],
    expectedArgs: [['acme', { runId: 'run-1', parentPath: '/guides', cursor: 'page-2', limit: 25 }]],
  },
  {
    tool: 'canonry_technical_aeo_internal_links',
    input: { project: 'acme', runId: 'run-1', sourceUrl: 'https://acme.test/a', targetUrl: 'https://acme.test/b', followable: false, cursor: 'page-2', limit: 25 },
    methods: ['getTechnicalAeoInternalLinks'],
    expectedArgs: [['acme', { runId: 'run-1', sourceUrl: 'https://acme.test/a', targetUrl: 'https://acme.test/b', followable: false, cursor: 'page-2', limit: 25 }]],
  },
  {
    tool: 'canonry_technical_aeo_link_neighbors',
    input: { project: 'acme', runId: 'run-1', nodeKey: 'node-1', limit: 25 },
    methods: ['getTechnicalAeoInternalLinkNeighbors'],
    expectedArgs: [['acme', { runId: 'run-1', nodeKey: 'node-1', url: undefined, limit: 25 }]],
  },
  {
    tool: 'canonry_technical_aeo_dead_links',
    input: { project: 'acme', runId: 'run-1', cursor: 'page-2', limit: 25 },
    methods: ['getTechnicalAeoDeadLinks'],
    expectedArgs: [['acme', { runId: 'run-1', cursor: 'page-2', limit: 25 }]],
  },
  {
    tool: 'canonry_technical_aeo_run',
    input: { project: 'acme', sitemapUrl: 'https://acme.test/sitemap.xml', maxPages: 50_000, maxEdges: 1_000_000, maxDepth: 12, checkDeadLinks: true },
    methods: ['triggerSiteAudit'],
    expectedArgs: [['acme', { sitemapUrl: 'https://acme.test/sitemap.xml', limit: undefined, maxPages: 50_000, maxEdges: 1_000_000, maxDepth: 12, checkDeadLinks: true }]],
  },
]

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
