import type { ProjectDto } from '@ainyc/aeo-platform-contracts'

import type {
  CitationInsightVm,
  DashboardVm,
  HealthSnapshot,
  ProjectCommandCenterVm,
  RunListItemVm,
} from './view-models.js'

export interface DashboardFixtureOptions {
  emptyPortfolio?: boolean
  degradedWorker?: boolean
  providerNeedsConfig?: boolean
  runScenario?: 'default' | 'partial' | 'failed'
  visibilityDropProjectId?: string
}

export interface DashboardFixture {
  dashboard: DashboardVm
  health: HealthSnapshot
}

const projects: ProjectDto[] = [
  {
    id: 'project_citypoint',
    name: 'Citypoint Dental NYC',
    canonicalDomain: 'citypointdental.com',
    country: 'US',
    language: 'en',
    tags: ['local intent', 'priority'],
    labels: {},
    configSource: 'cli',
    configRevision: 1,
  },
  {
    id: 'project_harbor',
    name: 'Harbor Legal Group',
    canonicalDomain: 'harborlegal.com',
    country: 'US',
    language: 'en',
    tags: ['lead gen'],
    labels: {},
    configSource: 'cli',
    configRevision: 1,
  },
  {
    id: 'project_northstar',
    name: 'Northstar Orthopedics',
    canonicalDomain: 'northstarortho.com',
    country: 'US',
    language: 'en',
    tags: ['multi-location'],
    labels: {},
    configSource: 'cli',
    configRevision: 1,
  },
]

function createRun(input: {
  id: string
  projectId: string
  projectName: string
  kind: 'answer-visibility' | 'site-audit'
  kindLabel: string
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed'
  createdAt: string
  startedAt: string
  duration: string
  statusDetail: string
  summary: string
  triggerLabel: string
  trigger?: 'manual' | 'scheduled' | 'config-apply'
}): RunListItemVm {
  return {
    id: input.id,
    projectId: input.projectId,
    projectName: input.projectName,
    kind: input.kind,
    kindLabel: input.kindLabel,
    status: input.status,
    trigger: input.trigger ?? 'manual',
    createdAt: input.createdAt,
    startedAt: input.startedAt,
    duration: input.duration,
    statusDetail: input.statusDetail,
    summary: input.summary,
    triggerLabel: input.triggerLabel,
  }
}

const runCitypointVisibility = createRun({
  id: 'run_citypoint_visibility_20260308',
  projectId: 'project_citypoint',
  projectName: 'Citypoint Dental NYC',
  kind: 'answer-visibility',
  kindLabel: 'Answer visibility sweep',
  status: 'completed',
  createdAt: '2026-03-08T12:15:00.000Z',
  startedAt: 'Mar 8, 12:15 PM',
  duration: '6m 12s',
  statusDetail: '18 tracked queries checked; 3 citation losses detected on emergency-intent prompts.',
  summary: 'Citation losses on emergency-intent prompts',
  triggerLabel: 'Scheduled',
})

const runCitypointAudit = createRun({
  id: 'run_citypoint_audit_20260308',
  projectId: 'project_citypoint',
  projectName: 'Citypoint Dental NYC',
  kind: 'site-audit',
  kindLabel: 'Technical readiness audit',
  status: 'partial',
  createdAt: '2026-03-08T09:20:00.000Z',
  startedAt: 'Mar 8, 9:20 AM',
  duration: '14m 41s',
  statusDetail: 'Sitemap fallback engaged; 461 of 500 pages analyzed and llms.txt was not found.',
  summary: 'Fallback crawl completed with missing llms.txt',
  triggerLabel: 'Manual',
})

const runCitypointQueued = createRun({
  id: 'run_citypoint_queued_20260309',
  projectId: 'project_citypoint',
  projectName: 'Citypoint Dental NYC',
  kind: 'answer-visibility',
  kindLabel: 'Answer visibility sweep',
  status: 'queued',
  createdAt: '2026-03-09T08:05:00.000Z',
  startedAt: 'Mar 9, 8:05 AM',
  duration: 'Waiting for slot',
  statusDetail: 'Ready to enqueue after the next provider rate window clears.',
  summary: 'Queued follow-up after local ranking movement',
  triggerLabel: 'Manual',
})

const runHarborVisibility = createRun({
  id: 'run_harbor_visibility_20260308',
  projectId: 'project_harbor',
  projectName: 'Harbor Legal Group',
  kind: 'answer-visibility',
  kindLabel: 'Answer visibility sweep',
  status: 'completed',
  createdAt: '2026-03-08T11:05:00.000Z',
  startedAt: 'Mar 8, 11:05 AM',
  duration: '5m 07s',
  statusDetail: '12 tracked queries checked; local-intent visibility held steady across branded prompts.',
  summary: 'Branded prompts remain stable',
  triggerLabel: 'Scheduled',
})

const runHarborAudit = createRun({
  id: 'run_harbor_audit_20260307',
  projectId: 'project_harbor',
  projectName: 'Harbor Legal Group',
  kind: 'site-audit',
  kindLabel: 'Technical readiness audit',
  status: 'completed',
  createdAt: '2026-03-07T15:40:00.000Z',
  startedAt: 'Mar 7, 3:40 PM',
  duration: '11m 33s',
  statusDetail: 'Sitemap-first crawl completed with 99% success and no blocking readiness regressions.',
  summary: 'Audit clean after service-page consolidation',
  triggerLabel: 'Scheduled',
})

const runNorthstarVisibility = createRun({
  id: 'run_northstar_visibility_20260308',
  projectId: 'project_northstar',
  projectName: 'Northstar Orthopedics',
  kind: 'answer-visibility',
  kindLabel: 'Answer visibility sweep',
  status: 'running',
  createdAt: '2026-03-08T13:40:00.000Z',
  startedAt: 'Mar 8, 1:40 PM',
  duration: '3m 10s',
  statusDetail: 'Provider responses still in flight for 9 multi-location prompts.',
  summary: 'Mid-run on treatment-location prompts',
  triggerLabel: 'Manual',
})

const allRuns: RunListItemVm[] = [
  runCitypointQueued,
  runCitypointVisibility,
  runCitypointAudit,
  runHarborVisibility,
  runHarborAudit,
  runNorthstarVisibility,
]

const citypointEvidence: CitationInsightVm[] = [
  {
    id: 'evidence_citypoint_emergency',
    keyword: 'emergency dentist brooklyn',
    citationState: 'lost',
    changeLabel: 'Lost since Mar 5',
    answerSnippet:
      'For urgent dental care in Brooklyn, Downtown Smiles and Harbor Dental are now cited first for emergency availability and same-day booking.',
    citedDomains: ['downtownsmiles.com', 'harbordental.com'],
    evidenceUrls: [
      'https://downtownsmiles.com/emergency-dentist-brooklyn',
      'https://harbordental.com/same-day-emergency-care',
    ],
    competitorDomains: ['downtownsmiles.com', 'harbordental.com'],
    groundingSources: [],
    relatedTechnicalSignals: [
      'FAQ schema missing on the emergency service page',
      'llms.txt not found during latest site audit',
      'Location pages link weakly into the emergency care hub',
    ],
    summary: 'AI answers now cite two competitors while your emergency page is no longer grounded.',
  },
  {
    id: 'evidence_citypoint_invisalign',
    keyword: 'best invisalign dentist downtown brooklyn',
    citationState: 'emerging',
    changeLabel: 'First citation in 7 days',
    answerSnippet:
      'Citypoint Dental appears as an emerging recommendation for Invisalign in Downtown Brooklyn, supported by recent before-and-after case pages.',
    citedDomains: ['citypointdental.com', 'clearlineortho.com'],
    evidenceUrls: [
      'https://citypointdental.com/invisalign-downtown-brooklyn',
      'https://citypointdental.com/case-studies/invisalign-open-bite',
    ],
    competitorDomains: ['clearlineortho.com'],
    groundingSources: [],
    relatedTechnicalSignals: [
      'Structured data now present on two case-study pages',
      'Internal links from service pages to case studies improved crawl depth',
    ],
    summary: 'Fresh case-study content is starting to earn citations on Invisalign prompts.',
  },
  {
    id: 'evidence_citypoint_children',
    keyword: 'pediatric dentist brooklyn heights',
    citationState: 'not-cited',
    changeLabel: 'No citation across 4 runs',
    answerSnippet:
      'Answers cite neighborhood-specific pediatric practices with stronger family-focused FAQ content and clearer insurance details.',
    citedDomains: ['brightkidsdental.com', 'parkpediatricdental.com'],
    evidenceUrls: [
      'https://brightkidsdental.com/pediatric-dentist-brooklyn-heights',
      'https://parkpediatricdental.com/insurance',
    ],
    competitorDomains: ['brightkidsdental.com', 'parkpediatricdental.com'],
    groundingSources: [],
    relatedTechnicalSignals: [
      'No dedicated pediatric service page exists for Brooklyn Heights',
      'Insurance content is buried three clicks deep',
    ],
    summary: 'Coverage gap is content-driven, not purely technical.',
  },
]

const baseProjectCommandCenters: ProjectCommandCenterVm[] = [
  {
    project: projects[0],
    dateRangeLabel: 'Last 7 days',
    contextLabel: 'US / English / Local-intent monitoring',
    visibilitySummary: {
      label: 'Answer Visibility',
      value: '61 / 100',
      delta: '-8 this week',
      tone: 'caution',
      description: 'Lost citation share on emergency-intent prompts while Invisalign visibility improved.',
      trend: [73, 71, 69, 66, 61],
    },
    readinessSummary: {
      label: 'Technical Readiness',
      value: '78 / 100',
      delta: '+4 after schema fixes',
      tone: 'positive',
      description: 'Schema fixes landed, but sitemap fallback and missing llms.txt still reduce confidence.',
      trend: [71, 72, 73, 76, 78],
    },
    competitorPressure: {
      label: 'Competitor Pressure',
      value: 'High',
      delta: '2 rivals moved up',
      tone: 'negative',
      description: 'Downtown Smiles and Harbor Dental now own the highest-intent local prompts.',
      trend: [54, 58, 61, 65, 69],
    },
    runStatus: {
      label: 'Run Status',
      value: 'Partial',
      delta: '1 queued follow-up',
      tone: 'caution',
      description: 'Latest technical audit completed in fallback mode; next visibility sweep is queued.',
      trend: [76, 74, 72, 68, 67],
    },
    insights: [
      {
        id: 'insight_citypoint_lost_citations',
        tone: 'negative',
        title: 'Lost citation on 3 money queries',
        detail: 'Emergency-intent prompts stopped grounding Citypoint after competitors refreshed availability pages.',
        actionLabel: 'Open evidence',
        evidenceId: 'evidence_citypoint_emergency',
      },
      {
        id: 'insight_citypoint_emerging',
        tone: 'positive',
        title: 'Fresh case studies are starting to work',
        detail: 'Invisalign prompts now cite Citypoint when case-study pages are mentioned in the answer rationale.',
        actionLabel: 'Review example',
        evidenceId: 'evidence_citypoint_invisalign',
      },
      {
        id: 'insight_citypoint_content_gap',
        tone: 'caution',
        title: 'Coverage gap is still content-led',
        detail: 'Pediatric prompts remain uncited because there is no dedicated neighborhood page to support them.',
        actionLabel: 'Inspect gap',
        evidenceId: 'evidence_citypoint_children',
      },
    ],
    visibilityEvidence: citypointEvidence,
    technicalFindings: [
      {
        id: 'finding_citypoint_schema',
        severity: 'high',
        title: 'Emergency service page lost FAQ schema',
        detail: 'The page most closely tied to high-intent emergency prompts is no longer exposing FAQPage markup.',
        impact: 'Removes a strong grounding signal from the page that previously earned citations.',
      },
      {
        id: 'finding_citypoint_llms',
        severity: 'medium',
        title: 'llms.txt is still missing',
        detail: 'The latest site audit could not fetch llms.txt or llms-full.txt.',
        impact: 'Lowers crawler clarity and weakens the story when visibility drops.',
      },
      {
        id: 'finding_citypoint_internal_links',
        severity: 'low',
        title: 'Insurance and pediatric content sit too deep',
        detail: 'Supporting pages needed for family and insurance prompts sit three clicks from the homepage.',
        impact: 'Limits discovery for lower-volume but high-trust prompt variants.',
      },
    ],
    competitors: [
      {
        id: 'competitor_citypoint_downtown',
        domain: 'downtownsmiles.com',
        citationCount: 4,
        totalKeywords: 8,
        pressureLabel: 'High',
        citedKeywords: ['emergency dentist', 'same-day dental', 'walk-in dentist', 'tooth pain'],
        movement: 'Up on emergency and availability prompts',
        notes: 'Recently added same-day booking proof and FAQ content.',
      },
      {
        id: 'competitor_citypoint_harbor',
        domain: 'harbordental.com',
        citationCount: 2,
        totalKeywords: 8,
        pressureLabel: 'Moderate',
        citedKeywords: ['family dentist', 'emergency dentist'],
        movement: 'Holding citations on family and emergency intents',
        notes: 'Strong appointment and insurance content keeps answers grounded.',
      },
      {
        id: 'competitor_citypoint_clearline',
        domain: 'clearlineortho.com',
        citationCount: 1,
        totalKeywords: 8,
        pressureLabel: 'Low',
        citedKeywords: ['invisalign near me'],
        movement: 'Softening on Invisalign prompts',
        notes: 'Case-study content is aging, opening room for Citypoint.',
      },
    ],
    recentRuns: [runCitypointQueued, runCitypointVisibility, runCitypointAudit],
  },
  {
    project: projects[1],
    dateRangeLabel: 'Last 14 days',
    contextLabel: 'US / English / Service-area legal prompts',
    visibilitySummary: {
      label: 'Answer Visibility',
      value: '74 / 100',
      delta: '+2 this week',
      tone: 'positive',
      description: 'Branded prompts are stable and informational queries are gradually improving.',
      trend: [68, 70, 71, 73, 74],
    },
    readinessSummary: {
      label: 'Technical Readiness',
      value: '83 / 100',
      delta: '+1 this week',
      tone: 'positive',
      description: 'Service pages consolidated cleanly and structured data remains intact.',
      trend: [80, 80, 81, 82, 83],
    },
    competitorPressure: {
      label: 'Competitor Pressure',
      value: 'Moderate',
      delta: 'Steady',
      tone: 'neutral',
      description: 'Competitors are stable; no new citation displacement was detected.',
      trend: [44, 46, 45, 46, 46],
    },
    runStatus: {
      label: 'Run Status',
      value: 'Healthy',
      delta: 'No failures in 14 days',
      tone: 'positive',
      description: 'Latest visibility and audit runs completed without fallback.',
      trend: [88, 89, 90, 90, 91],
    },
    insights: [
      {
        id: 'insight_harbor_cluster',
        tone: 'positive',
        title: 'Practice-area clustering is paying off',
        detail: 'Merged legal service pages now ground broader informational prompts without hurting conversion intent.',
        actionLabel: 'Review evidence',
      },
      {
        id: 'insight_harbor_local',
        tone: 'neutral',
        title: 'Local pack competitors are steady',
        detail: 'No new displacement on borough-specific injury prompts this week.',
        actionLabel: 'Keep monitoring',
      },
    ],
    visibilityEvidence: [
      {
        id: 'evidence_harbor_personal_injury',
        keyword: 'brooklyn personal injury lawyer',
        citationState: 'cited',
        changeLabel: 'Held for 5 runs',
        answerSnippet:
          'Harbor Legal Group remains cited for borough-specific personal injury queries due to clear practice-area and case-result content.',
        citedDomains: ['harborlegal.com'],
        evidenceUrls: ['https://harborlegal.com/personal-injury/brooklyn'],
        competitorDomains: ['shorelineinjury.com'],
        groundingSources: [],
    relatedTechnicalSignals: ['Practice-area schema intact', 'Case results link directly from service pages'],
        summary: 'Grounding remains durable after the service-page consolidation.',
      },
    ],
    technicalFindings: [
      {
        id: 'finding_harbor_faq',
        severity: 'low',
        title: 'FAQ answers could be more concise',
        detail: 'Some FAQ answers are still long enough to reduce snippet clarity.',
        impact: 'This is optimization, not a blocker.',
      },
    ],
    competitors: [
      {
        id: 'competitor_harbor_shoreline',
        domain: 'shorelineinjury.com',
        citationCount: 2,
        totalKeywords: 6,
        pressureLabel: 'Moderate',
        citedKeywords: ['personal injury lawyer', 'car accident attorney'],
        movement: 'Stable',
        notes: 'Strong case-result pages keep it in rotation.',
      },
    ],
    recentRuns: [runHarborVisibility, runHarborAudit],
  },
  {
    project: projects[2],
    dateRangeLabel: 'Last 7 days',
    contextLabel: 'US / English / Multi-location treatment prompts',
    visibilitySummary: {
      label: 'Answer Visibility',
      value: '58 / 100',
      delta: 'Run in progress',
      tone: 'neutral',
      description: 'The current run is measuring whether treatment-location pages improved citation breadth.',
      trend: [52, 54, 55, 57, 58],
    },
    readinessSummary: {
      label: 'Technical Readiness',
      value: '76 / 100',
      delta: '+3 after template cleanup',
      tone: 'positive',
      description: 'Location templates are cleaner, but location-specific proof still needs depth.',
      trend: [69, 71, 72, 74, 76],
    },
    competitorPressure: {
      label: 'Competitor Pressure',
      value: 'Moderate',
      delta: 'Watching 1 chain',
      tone: 'caution',
      description: 'Regional chain competitors are winning on broad treatment questions.',
      trend: [49, 51, 52, 54, 56],
    },
    runStatus: {
      label: 'Run Status',
      value: 'Running',
      delta: '9 prompts remaining',
      tone: 'neutral',
      description: 'Current answer-visibility sweep is still collecting provider responses.',
      trend: [63, 64, 65, 67, 68],
    },
    insights: [
      {
        id: 'insight_northstar_location_depth',
        tone: 'caution',
        title: 'Location pages need stronger proof',
        detail: 'The templates are clean, but answers still prefer competitors with physician-specific evidence.',
        actionLabel: 'Track current run',
      },
    ],
    visibilityEvidence: [
      {
        id: 'evidence_northstar_knee',
        keyword: 'knee replacement surgeon westchester',
        citationState: 'emerging',
        changeLabel: 'Improving',
        answerSnippet:
          'Northstar Orthopedics is beginning to appear on location-sensitive treatment prompts when physician bios and treatment pages are tightly linked.',
        citedDomains: ['northstarortho.com', 'regionaljointcare.com'],
        evidenceUrls: [
          'https://northstarortho.com/locations/westchester/knee-replacement',
        ],
        competitorDomains: ['regionaljointcare.com'],
        groundingSources: [],
    relatedTechnicalSignals: ['Physician bios now linked from treatment pages'],
        summary: 'Template cleanup is helping, but proof depth still matters.',
      },
    ],
    technicalFindings: [
      {
        id: 'finding_northstar_proof',
        severity: 'medium',
        title: 'Location pages lack physician-specific proof',
        detail: 'Treatment pages are structurally sound but still too generic for highly specific prompts.',
        impact: 'Limits how often the provider is cited for local treatment questions.',
      },
    ],
    competitors: [
      {
        id: 'competitor_northstar_regional',
        domain: 'regionaljointcare.com',
        citationCount: 5,
        totalKeywords: 7,
        pressureLabel: 'High',
        citedKeywords: ['knee replacement', 'hip surgery', 'joint pain treatment', 'orthopedic surgeon', 'sports medicine'],
        movement: 'Winning broad treatment prompts',
        notes: 'Heavy physician proof and patient-story content.',
      },
    ],
    recentRuns: [runNorthstarVisibility],
  },
]

const baseDashboard: DashboardVm = {
  portfolioOverview: {
    projects: [
      {
        project: projects[0],
        visibilityScore: 61,
        visibilityDelta: '-8 this week',
        readinessScore: 78,
        readinessDelta: '+4 after schema fixes',
        lastRun: runCitypointAudit,
        insight: 'Lost emergency-intent citations after competitors refreshed availability pages.',
        trend: [73, 71, 69, 66, 61],
        competitorPressureLabel: 'High',
      },
      {
        project: projects[1],
        visibilityScore: 74,
        visibilityDelta: '+2 this week',
        readinessScore: 83,
        readinessDelta: '+1 this week',
        lastRun: runHarborVisibility,
        insight: 'Practice-area consolidation is stabilizing branded and informational prompts.',
        trend: [68, 70, 71, 73, 74],
        competitorPressureLabel: 'Moderate',
      },
      {
        project: projects[2],
        visibilityScore: 58,
        visibilityDelta: 'Run in progress',
        readinessScore: 76,
        readinessDelta: '+3 after template cleanup',
        lastRun: runNorthstarVisibility,
        insight: 'Location pages are improving, but local treatment proof still trails competitors.',
        trend: [52, 54, 55, 57, 58],
        competitorPressureLabel: 'Moderate',
      },
    ],
    attentionItems: [
      {
        id: 'attention_citypoint',
        tone: 'negative',
        title: 'Citypoint Dental lost emergency-intent citations',
        detail: 'Three high-intent prompts now cite competitors first.',
        actionLabel: 'Open project',
        href: '/projects/project_citypoint',
      },
      {
        id: 'attention_worker',
        tone: 'neutral',
        title: 'One follow-up run is queued',
        detail: 'Citypoint has a queued visibility sweep waiting on provider quota.',
        actionLabel: 'Open runs',
        href: '/runs',
      },
      {
        id: 'attention_northstar',
        tone: 'caution',
        title: 'Northstar run still in progress',
        detail: 'Nine prompts remain before the current treatment-location sweep finishes.',
        actionLabel: 'View timeline',
        href: '/runs',
      },
    ],
    recentRuns: [runCitypointQueued, runNorthstarVisibility, runCitypointAudit],
    systemHealth: [
      {
        id: 'api',
        label: 'API',
        tone: 'positive',
        detail: 'Healthy',
        meta: 'phase-1 · database configured',
      },
      {
        id: 'worker',
        label: 'Worker',
        tone: 'positive',
        detail: 'Healthy',
        meta: 'heartbeat moments ago',
      },
      {
        id: 'provider',
        label: 'Gemini',
        tone: 'positive',
        detail: 'Configured',
        meta: '2 concurrent · 10/min · 1000/day',
      },
    ],
    lastUpdatedAt: 'Mar 9, 8:08 AM ET',
  },
  projects: baseProjectCommandCenters,
  runs: allRuns,
  setup: {
    healthChecks: [
      {
        id: 'api',
        label: 'API reachable',
        detail: 'Primary control plane is responding.',
        state: 'ready',
        guidance: 'Required for project creation and run history.',
      },
      {
        id: 'worker',
        label: 'Worker heartbeats received',
        detail: 'Background execution loop is alive.',
        state: 'ready',
        guidance: 'Required before any answer-visibility or site-audit run can start.',
      },
      {
        id: 'provider',
        label: 'Provider configured',
        detail: 'Gemini key and quota defaults are present.',
        state: 'ready',
        guidance: 'Required for answer-visibility sweeps.',
      },
    ],
    projectDraft: {
      name: 'Citypoint Dental NYC',
      canonicalDomain: 'citypointdental.com',
      country: 'US',
      language: 'en',
    },
    keywordImportState: {
      mode: 'paste',
      keywordCount: 18,
      preview: [
        'emergency dentist brooklyn',
        'best invisalign dentist downtown brooklyn',
        'pediatric dentist brooklyn heights',
      ],
    },
    competitorDraft: {
      domains: ['downtownsmiles.com', 'harbordental.com', 'clearlineortho.com'],
      notes: 'Start with the domains that already displace the project on money prompts.',
    },
    launchState: {
      enabled: true,
      ctaLabel: 'Launch first run',
      summary: 'Queue a visibility sweep first, then follow with a site audit to explain movement.',
    },
  },
  settings: {
    providerStatus: {
      name: 'Gemini',
      model: 'gemini-2.5-flash',
      state: 'ready',
      detail: 'API key detected and conservative quota defaults are active.',
    },
    quotaSummary: {
      maxConcurrency: 2,
      maxRequestsPerMinute: 10,
      maxRequestsPerDay: 1000,
    },
    selfHostNotes: [
      'Run behind a reverse proxy before exposing the dashboard outside a trusted network.',
      'Keep bootstrap and provider secrets out of source control.',
      'Use persistent Postgres storage before treating run history as durable.',
    ],
    bootstrapNote: 'Bootstrap/admin secrets stay in the environment; they do not belong in the UI.',
  },
}

const baseHealthSnapshot: HealthSnapshot = {
  apiStatus: {
    label: 'API',
    state: 'ok',
    detail: 'phase-1 · database configured',
    version: 'phase-1',
    databaseConfigured: true,
  },
  workerStatus: {
    label: 'Worker',
    state: 'ok',
    detail: 'phase-1 · database configured · heartbeat 2026-03-09T08:07:00.000Z',
    version: 'phase-1',
    databaseConfigured: true,
    lastHeartbeatAt: '2026-03-09T08:07:00.000Z',
  },
}

export function createDashboardFixture(options: DashboardFixtureOptions = {}): DashboardFixture {
  const dashboard = structuredClone(baseDashboard)
  const health = structuredClone(baseHealthSnapshot)

  if (options.emptyPortfolio) {
    dashboard.portfolioOverview.projects = []
    dashboard.portfolioOverview.attentionItems = [
      {
        id: 'attention_setup',
        tone: 'neutral',
        title: 'No projects yet',
        detail: 'Start the guided setup flow to add a domain, import keywords, and launch the first run.',
        actionLabel: 'Open setup',
        href: '/setup',
      },
    ]
    dashboard.portfolioOverview.recentRuns = []
    dashboard.portfolioOverview.emptyState = {
      title: 'No projects yet',
      detail: 'Canonry becomes useful after one project, a small keyword set, and one competitor list are in place.',
      ctaLabel: 'Launch setup',
      ctaHref: '/setup',
    }
  }

  if (options.runScenario === 'partial') {
    dashboard.runs[0].status = 'partial'
    dashboard.runs[0].duration = '7m 24s'
    dashboard.runs[0].statusDetail = 'Quota window closed mid-run; 14 of 18 prompts completed before the worker paused.'
    dashboard.runs[0].summary = 'Partial visibility sweep after quota cap'
    dashboard.portfolioOverview.recentRuns[0] = dashboard.runs[0]
  }

  if (options.runScenario === 'failed') {
    dashboard.runs[0].status = 'failed'
    dashboard.runs[0].duration = '1m 43s'
    dashboard.runs[0].statusDetail = 'Worker could not reach the provider after repeated retry exhaustion.'
    dashboard.runs[0].summary = 'Provider retries exhausted before results were captured'
    dashboard.portfolioOverview.recentRuns[0] = dashboard.runs[0]
    dashboard.portfolioOverview.attentionItems.unshift({
      id: 'attention_failed_run',
      tone: 'negative',
      title: 'One queued follow-up failed to start cleanly',
      detail: 'Worker retries exhausted before the provider returned a response.',
      actionLabel: 'Open runs',
      href: '/runs',
    })
  }

  if (options.degradedWorker) {
    health.workerStatus = {
      label: 'Worker',
      state: 'error',
      detail: 'heartbeat stale · last seen 12m ago',
      version: 'phase-1',
      databaseConfigured: true,
      lastHeartbeatAt: '2026-03-09T07:55:00.000Z',
    }
  }

  if (options.providerNeedsConfig) {
    dashboard.settings.providerStatus = {
      name: 'Gemini',
      model: 'gemini-2.5-flash',
      state: 'needs-config',
      detail: 'API key is missing, so answer-visibility sweeps are blocked.',
    }
  }

  if (options.visibilityDropProjectId) {
    const project = dashboard.projects.find((entry) => entry.project.id === options.visibilityDropProjectId)
    const portfolioProject = dashboard.portfolioOverview.projects.find(
      (entry) => entry.project.id === options.visibilityDropProjectId,
    )

    if (project) {
      project.visibilitySummary.value = '49 / 100'
      project.visibilitySummary.delta = '-12 in 48h'
      project.visibilitySummary.tone = 'negative'
      project.visibilitySummary.description = 'A sharper drop than normal; citations slipped across both local and service-intent prompts.'
      project.insights.unshift({
        id: `${project.project.id}_drop`,
        tone: 'negative',
        title: 'Sharp citation drop detected',
        detail: 'Answers that previously cited the domain now ground competitors on both local and service-intent prompts.',
        actionLabel: 'Open evidence',
        evidenceId: project.visibilityEvidence[0]?.id,
      })
      project.technicalFindings?.unshift({
        id: `${project.project.id}_drop_finding`,
        severity: 'high',
        title: 'Primary supporting page fell out of crawl emphasis',
        detail: 'The drop correlates with weaker internal links and missing FAQ markup on the main conversion page.',
        impact: 'Both citation share and trust signals deteriorated at the same time.',
      })
    }

    if (portfolioProject) {
      portfolioProject.visibilityScore = 49
      portfolioProject.visibilityDelta = '-12 in 48h'
      portfolioProject.insight = 'Sharp citation drop detected; grounding now prefers competitors on multiple high-intent prompts.'
    }
  }

  return { dashboard, health }
}

export function findProjectVm(dashboard: DashboardVm, projectId: string): ProjectCommandCenterVm | undefined {
  return dashboard.projects.find((entry) => entry.project.id === projectId)
}

export function findRunById(dashboard: DashboardVm, runId: string): RunListItemVm | undefined {
  return dashboard.runs.find((entry) => entry.id === runId)
}

export function findEvidenceById(
  dashboard: DashboardVm,
  evidenceId: string,
): { project: ProjectCommandCenterVm; evidence: CitationInsightVm } | undefined {
  for (const project of dashboard.projects) {
    const evidence = project.visibilityEvidence.find((entry) => entry.id === evidenceId)
    if (evidence) {
      return { project, evidence }
    }
  }

  return undefined
}
