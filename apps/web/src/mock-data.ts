import type { ProjectDto } from '@ainyc/canonry-contracts'

import type {
  CitationInsightVm,
  DashboardVm,
  HealthSnapshot,
  ProjectCommandCenterVm,
  RunHistoryPoint,
  RunListItemVm,
} from './view-models.js'

/** Generate mock run history for a given pattern of citation states. */
function mockHistory(states: string[]): RunHistoryPoint[] {
  const base = new Date('2026-02-20')
  return states.map((s, i) => ({
    runId: `run_mock_${i + 1}`,
    citationState: s,
    createdAt: new Date(base.getTime() + i * 2 * 24 * 60 * 60 * 1000).toISOString(),
  }))
}

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
    ownedDomains: [],
    aliases: [],
    country: 'US',
    language: 'en',
    tags: ['local intent', 'priority'],
    labels: {},
    providers: [],
    locations: [],
    defaultLocation: null,
    autoExtractBacklinks: false,
    configSource: 'cli',
    configRevision: 1,
  },
  {
    id: 'project_harbor',
    name: 'Harbor Legal Group',
    canonicalDomain: 'harborlegal.com',
    ownedDomains: [],
    aliases: [],
    country: 'US',
    language: 'en',
    tags: ['lead gen'],
    labels: {},
    providers: [],
    locations: [],
    defaultLocation: null,
    autoExtractBacklinks: false,
    configSource: 'cli',
    configRevision: 1,
  },
  {
    id: 'project_northstar',
    name: 'Northstar Orthopedics',
    canonicalDomain: 'northstarortho.com',
    ownedDomains: [],
    aliases: [],
    country: 'US',
    language: 'en',
    tags: ['multi-location'],
    labels: {},
    providers: [],
    locations: [],
    defaultLocation: null,
    autoExtractBacklinks: false,
    configSource: 'cli',
    configRevision: 1,
  },
]

function createRun(input: {
  id: string
  projectId: string
  projectName: string
  kind: 'answer-visibility'
  kindLabel: string
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'
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
  runHarborVisibility,
  runNorthstarVisibility,
]

const citypointEvidence: CitationInsightVm[] = [
  // emergency dentist brooklyn — 3 providers
  {
    id: 'evidence_citypoint_emergency_gemini',
    query: 'emergency dentist brooklyn',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    location: null,
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
    runHistory: mockHistory(['cited', 'cited', 'cited', 'cited', 'cited', 'cited', 'cited', 'not-cited', 'not-cited']),
  },
  {
    id: 'evidence_citypoint_emergency_openai',
    query: 'emergency dentist brooklyn',
    provider: 'openai',
    model: 'gpt-5.4',
    location: null,
    citationState: 'cited',
    changeLabel: 'Cited for 6 runs',
    answerSnippet:
      'Citypoint Dental is listed as a top emergency dentist in Brooklyn for same-day appointments and walk-in availability.',
    citedDomains: ['citypointdental.com', 'downtownsmiles.com'],
    evidenceUrls: ['https://citypointdental.com/emergency-dentist-brooklyn'],
    competitorDomains: ['downtownsmiles.com'],
    groundingSources: [],
    relatedTechnicalSignals: ['Emergency page indexed with structured data'],
    summary: 'OpenAI cites your emergency page consistently alongside one competitor.',
    runHistory: mockHistory(['not-cited', 'cited', 'cited', 'cited', 'cited', 'cited', 'cited']),
  },
  {
    id: 'evidence_citypoint_emergency_claude',
    query: 'emergency dentist brooklyn',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    location: null,
    citationState: 'not-cited',
    changeLabel: 'No citation across 12 runs',
    answerSnippet:
      'Based on the search results, top-rated emergency dental practices in Brooklyn include Downtown Smiles and Harbor Dental.',
    citedDomains: ['downtownsmiles.com', 'harbordental.com'],
    evidenceUrls: [],
    competitorDomains: ['downtownsmiles.com', 'harbordental.com'],
    groundingSources: [],
    relatedTechnicalSignals: ['FAQ schema missing', 'llms.txt not found'],
    summary: 'Claude does not cite your domain for this emergency query.',
    runHistory: mockHistory(['not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited']),
  },

  // best invisalign dentist downtown brooklyn — 3 providers
  {
    id: 'evidence_citypoint_invisalign_openai',
    query: 'best invisalign dentist downtown brooklyn',
    provider: 'openai',
    model: 'gpt-5.4',
    location: null,
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
    runHistory: mockHistory(['not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'cited']),
  },
  {
    id: 'evidence_citypoint_invisalign_gemini',
    query: 'best invisalign dentist downtown brooklyn',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    location: null,
    citationState: 'cited',
    changeLabel: 'Cited for 8 runs',
    answerSnippet:
      'Citypoint Dental in Downtown Brooklyn is highlighted for its Invisalign expertise and patient outcomes.',
    citedDomains: ['citypointdental.com'],
    evidenceUrls: ['https://citypointdental.com/invisalign-downtown-brooklyn'],
    competitorDomains: [],
    groundingSources: [],
    relatedTechnicalSignals: ['Case study pages well-indexed'],
    summary: 'Gemini consistently cites your Invisalign page with no competitor overlap.',
    runHistory: mockHistory(['cited', 'cited', 'cited', 'cited', 'cited', 'cited', 'cited', 'cited']),
  },
  {
    id: 'evidence_citypoint_invisalign_claude',
    query: 'best invisalign dentist downtown brooklyn',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    location: null,
    citationState: 'not-cited',
    changeLabel: 'No citation across 12 runs',
    answerSnippet:
      'For Invisalign in Downtown Brooklyn, Clear Line Ortho and Brooklyn Smiles are frequently recommended for their experienced orthodontists.',
    citedDomains: ['clearlineortho.com', 'brooklynsmiles.com'],
    evidenceUrls: [],
    competitorDomains: ['clearlineortho.com'],
    groundingSources: [],
    relatedTechnicalSignals: ['No before/after schema on case study pages'],
    summary: 'Claude does not surface your Invisalign content despite strong page quality.',
    runHistory: mockHistory(['not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited']),
  },

  // pediatric dentist brooklyn heights — 3 providers
  {
    id: 'evidence_citypoint_children_claude',
    query: 'pediatric dentist brooklyn heights',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    location: null,
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
    runHistory: mockHistory(['not-cited', 'not-cited', 'not-cited', 'not-cited']),
  },
  {
    id: 'evidence_citypoint_children_gemini',
    query: 'pediatric dentist brooklyn heights',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    location: null,
    citationState: 'not-cited',
    changeLabel: 'No citation across 12 runs',
    answerSnippet:
      'For pediatric dentistry in Brooklyn Heights, Bright Kids Dental and Park Pediatric Dental are cited for family-friendly care.',
    citedDomains: ['brightkidsdental.com', 'parkpediatricdental.com'],
    evidenceUrls: [],
    competitorDomains: ['brightkidsdental.com', 'parkpediatricdental.com'],
    groundingSources: [],
    relatedTechnicalSignals: ['No dedicated pediatric page for Brooklyn Heights'],
    summary: 'Gemini does not surface your domain for pediatric queries in this area.',
    runHistory: mockHistory(['not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited']),
  },
  {
    id: 'evidence_citypoint_children_openai',
    query: 'pediatric dentist brooklyn heights',
    provider: 'openai',
    model: 'gpt-5.4',
    location: null,
    citationState: 'cited',
    changeLabel: 'First citation this month',
    answerSnippet:
      'Citypoint Dental is mentioned as offering pediatric services in Brooklyn, though specialized pediatric-only practices are also highlighted.',
    citedDomains: ['citypointdental.com', 'brightkidsdental.com'],
    evidenceUrls: ['https://citypointdental.com/family-dentistry'],
    competitorDomains: ['brightkidsdental.com'],
    groundingSources: [],
    relatedTechnicalSignals: ['Family dentistry page recently updated'],
    summary: 'OpenAI recently started citing your family dentistry page for this query.',
    runHistory: mockHistory(['not-cited', 'not-cited', 'not-cited', 'not-cited', 'not-cited', 'cited']),
  },
]

const baseProjectCommandCenters: ProjectCommandCenterVm[] = [
  {
    project: projects[0],
    dateRangeLabel: 'Last 7 days',
    contextLabel: 'US / English / Local-intent monitoring',
    mentionSummary: {
      label: 'Mention Coverage',
      value: '74',
      delta: '6 of 8 queries mentioned',
      tone: 'positive',
      description: 'Brand named in answer text for most tracked queries.',
      trend: [70, 72, 73, 74, 74],
      progress: 74,
    },
    visibilitySummary: {
      label: 'Citation Coverage',
      value: '61 / 100',
      delta: '-8 this week',
      tone: 'caution',
      description: 'Lost citation share on emergency-intent prompts while Invisalign visibility improved.',
      trend: [73, 71, 69, 66, 61],
    },
    mentionShareSummary: {
      label: 'Mention Share',
      value: '38',
      delta: '8 of 21 brand mentions',
      tone: 'caution',
      description: 'Downtown Smiles leads on emergency intent; Citypoint trails on availability copy.',
      trend: [44, 42, 40, 39, 38],
      progress: 38,
      breakdown: {
        projectMentionSnapshots: 8,
        competitorMentionSnapshots: 13,
        perCompetitor: [
          { domain: 'downtownsmiles.com', mentionSnapshots: 9, shareOfCompetitiveTotal: 69.2 },
          { domain: 'harbordental.com', mentionSnapshots: 4, shareOfCompetitiveTotal: 30.8 },
        ],
        snapshotsWithAnswerText: 24,
        snapshotsTotal: 32,
      },
    },
    gapQueries: {
      label: 'Citation Gaps',
      value: '1',
      delta: '1 of 8 queries at risk',
      tone: 'caution',
      description: 'One tracked query currently cites competitors without citing Citypoint.',
      trend: [],
      progress: 0.125,
    },
    mentionGaps: {
      label: 'Mention Gaps',
      value: '2',
      delta: '2 of 8 queries at risk',
      tone: 'caution',
      description: 'Two tracked queries mention competitors but never Citypoint.',
      trend: [],
      progress: 0.25,
    },
    indexCoverage: {
      label: 'Index Coverage',
      value: '82',
      delta: 'Google · 46 of 56 indexed',
      tone: 'caution',
      description: '10 URLs are not indexed in Google Search Console.',
      trend: [84, 84, 83, 82, 82],
    },
    providerScores: [
      { provider: 'gemini', model: 'gemini-2.5-flash', score: 55, cited: 5, total: 9 },
      { provider: 'openai', model: 'gpt-5.4', score: 67, cited: 6, total: 9 },
      { provider: 'claude', model: 'claude-sonnet-4-6', score: 44, cited: 4, total: 9 },
    ],
    queryCounts: { cited: 6, total: 9 },
    movementSummary: { gained: 1, lost: 2, tone: 'negative', hasPreviousRun: true },
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
      description: 'Latest visibility sweep completed; next sweep is queued.',
      trend: [76, 74, 72, 68, 67],
    },
    insights: [
      {
        id: 'insight_citypoint_lost_citations',
        tone: 'negative',
        title: 'Lost citation on 1 query',
        detail: 'Emergency-intent prompts stopped grounding Citypoint after competitors refreshed.',
        actionLabel: 'Lost',
        actionGroup: 'investigate',
        affectedPhrases: [{
          query: 'emergency dentist brooklyn',
          evidenceId: 'evidence_citypoint_emergency_gemini',
          provider: 'gemini',
          citationState: 'lost',
        }],
      },
      {
        id: 'insight_citypoint_emerging',
        tone: 'positive',
        title: 'New citation on 1 query',
        detail: 'Case-study content is earning citations on Invisalign prompts.',
        actionLabel: 'Emerging',
        actionGroup: 'monitor',
        affectedPhrases: [{
          query: 'best invisalign dentist downtown brooklyn',
          evidenceId: 'evidence_citypoint_invisalign_openai',
          provider: 'openai',
          citationState: 'emerging',
        }],
      },
      {
        id: 'insight_citypoint_content_gap',
        tone: 'caution',
        title: '1 query not cited by any provider',
        detail: 'No dedicated neighborhood page to support pediatric queries.',
        actionLabel: 'Gap',
        actionGroup: 'write',
        affectedPhrases: [{
          query: 'pediatric dentist brooklyn heights',
          evidenceId: 'evidence_citypoint_children_claude',
          provider: 'claude',
          citationState: 'not-cited',
        }],
      },
    ],
    visibilityEvidence: citypointEvidence,
    competitors: [
      {
        id: 'competitor_citypoint_downtown',
        domain: 'downtownsmiles.com',
        citationCount: 4,
        totalQueries: 8,
        pressureLabel: 'High',
        citedQueries: ['emergency dentist', 'same-day dental', 'walk-in dentist', 'tooth pain'],
        movement: 'Up on emergency and availability prompts',
        notes: 'Recently added same-day booking proof and FAQ content.',
      },
      {
        id: 'competitor_citypoint_harbor',
        domain: 'harbordental.com',
        citationCount: 2,
        totalQueries: 8,
        pressureLabel: 'Moderate',
        citedQueries: ['family dentist', 'emergency dentist'],
        movement: 'Holding citations on family and emergency intents',
        notes: 'Strong appointment and insurance content keeps answers grounded.',
      },
      {
        id: 'competitor_citypoint_clearline',
        domain: 'clearlineortho.com',
        citationCount: 1,
        totalQueries: 8,
        pressureLabel: 'Low',
        citedQueries: ['invisalign near me'],
        movement: 'Softening on Invisalign prompts',
        notes: 'Case-study content is aging, opening room for Citypoint.',
      },
    ],
    recentRuns: [runCitypointQueued, runCitypointVisibility],
    suggestedQueries: {
      rows: [
        { query: 'emergency dentist near me', impressions: 4200, clicks: 87, avgPosition: 8, reason: '4.2K impressions · ranks #8 on Google' },
        { query: 'invisalign brooklyn cost', impressions: 1850, clicks: 32, avgPosition: 14, reason: '1.9K impressions · ranks #14 — close to top 10' },
        { query: 'dental implants downtown brooklyn', impressions: 920, clicks: 18, avgPosition: 22, reason: '920 impressions · ranks #22' },
      ],
      totalCandidates: 8,
      skippedAlreadyTracked: 5,
    },
  },
  {
    project: projects[1],
    dateRangeLabel: 'Last 14 days',
    contextLabel: 'US / English / Service-area legal prompts',
    mentionSummary: {
      label: 'Mention Coverage',
      value: '82',
      delta: '9 of 11 queries mentioned',
      tone: 'positive',
      description: 'Brand named in answer text on most tracked prompts.',
      trend: [76, 78, 80, 81, 82],
      progress: 82,
    },
    visibilitySummary: {
      label: 'Citation Coverage',
      value: '74 / 100',
      delta: '+2 this week',
      tone: 'positive',
      description: 'Branded prompts are stable and informational queries are gradually improving.',
      trend: [68, 70, 71, 73, 74],
    },
    mentionShareSummary: {
      label: 'Mention Share',
      value: '64',
      delta: '11 of 17 brand mentions',
      tone: 'positive',
      description: 'Harbor Law outpaces Shoreline on branded and informational injury prompts.',
      trend: [58, 60, 62, 63, 64],
      progress: 64,
      breakdown: {
        projectMentionSnapshots: 11,
        competitorMentionSnapshots: 6,
        perCompetitor: [
          { domain: 'shorelineinjury.com', mentionSnapshots: 6, shareOfCompetitiveTotal: 100 },
        ],
        snapshotsWithAnswerText: 19,
        snapshotsTotal: 24,
      },
    },
    gapQueries: {
      label: 'Citation Gaps',
      value: '0',
      delta: '0 of 6 queries at risk',
      tone: 'positive',
      description: 'No competitive citation gaps detected in the latest visibility run.',
      trend: [],
      progress: 0,
    },
    mentionGaps: {
      label: 'Mention Gaps',
      value: '0',
      delta: '0 of 6 queries at risk',
      tone: 'positive',
      description: 'No competitive mention gaps detected in the latest visibility run.',
      trend: [],
      progress: 0,
    },
    indexCoverage: {
      label: 'Index Coverage',
      value: '91',
      delta: 'Google · 51 of 56 indexed',
      tone: 'positive',
      description: '5 URLs are not indexed in Google Search Console.',
      trend: [88, 89, 89, 90, 91],
    },
    providerScores: [
      { provider: 'gemini', model: 'gemini-2.5-flash', score: 75, cited: 3, total: 4 },
      { provider: 'openai', model: 'gpt-5.4', score: 50, cited: 2, total: 4 },
    ],
    queryCounts: { cited: 3, total: 4 },
    movementSummary: { gained: 1, lost: 0, tone: 'positive', hasPreviousRun: true },
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
      description: 'Latest visibility runs completed without issues.',
      trend: [88, 89, 90, 90, 91],
    },
    insights: [
      {
        id: 'insight_harbor_cluster',
        tone: 'positive',
        title: 'Practice-area clustering is paying off',
        detail: 'Merged legal service pages now ground broader informational prompts.',
        actionLabel: 'Cited',
        actionGroup: 'monitor',
        affectedPhrases: [{
          query: 'brooklyn personal injury lawyer',
          evidenceId: 'evidence_harbor_personal_injury',
          provider: 'gemini',
          citationState: 'cited',
        }],
      },
      {
        id: 'insight_harbor_local',
        tone: 'neutral',
        title: 'No significant changes',
        detail: 'No new displacement on borough-specific injury prompts this week.',
        actionLabel: 'Stable',
        actionGroup: 'monitor',
        affectedPhrases: [],
      },
    ],
    visibilityEvidence: [
      {
        id: 'evidence_harbor_personal_injury',
        query: 'brooklyn personal injury lawyer',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        location: null,
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
        runHistory: mockHistory(['cited', 'cited', 'cited', 'cited', 'cited']),
      },
    ],
    competitors: [
      {
        id: 'competitor_harbor_shoreline',
        domain: 'shorelineinjury.com',
        citationCount: 2,
        totalQueries: 6,
        pressureLabel: 'Moderate',
        citedQueries: ['personal injury lawyer', 'car accident attorney'],
        movement: 'Stable',
        notes: 'Strong case-result pages keep it in rotation.',
      },
    ],
    recentRuns: [runHarborVisibility],
    suggestedQueries: {
      rows: [
        { query: 'car accident lawyer monmouth county', impressions: 2300, clicks: 41, avgPosition: 6, reason: '2.3K impressions · ranks #6 on Google' },
      ],
      totalCandidates: 1,
      skippedAlreadyTracked: 4,
    },
  },
  {
    project: projects[2],
    dateRangeLabel: 'Last 7 days',
    contextLabel: 'US / English / Multi-location treatment prompts',
    mentionSummary: {
      label: 'Mention Coverage',
      value: '67',
      delta: '10 of 15 queries mentioned',
      tone: 'caution',
      description: 'Brand named in the answer text for most queries; gaps on long-tail location prompts.',
      trend: [60, 63, 65, 66, 67],
      progress: 67,
    },
    visibilitySummary: {
      label: 'Citation Coverage',
      value: '58 / 100',
      delta: 'Run in progress',
      tone: 'neutral',
      description: 'The current run is measuring whether treatment-location pages improved citation breadth.',
      trend: [52, 54, 55, 57, 58],
    },
    mentionShareSummary: {
      label: 'Mention Share',
      value: '21',
      delta: '4 of 19 brand mentions',
      tone: 'negative',
      description: 'Regional Joint Care dominates broad treatment prompts with deeper physician proof.',
      trend: [28, 26, 24, 22, 21],
      progress: 21,
      breakdown: {
        projectMentionSnapshots: 4,
        competitorMentionSnapshots: 15,
        perCompetitor: [
          { domain: 'regionaljointcare.com', mentionSnapshots: 15, shareOfCompetitiveTotal: 100 },
        ],
        snapshotsWithAnswerText: 21,
        snapshotsTotal: 28,
      },
    },
    gapQueries: {
      label: 'Citation Gaps',
      value: '2',
      delta: '2 of 7 queries at risk',
      tone: 'caution',
      description: 'Two tracked queries currently cite competitors without citing Northstar.',
      trend: [],
      progress: 2 / 7,
    },
    mentionGaps: {
      label: 'Mention Gaps',
      value: '3',
      delta: '3 of 7 queries at risk',
      tone: 'negative',
      description: 'Three tracked queries mention competitors but never Northstar.',
      trend: [],
      progress: 3 / 7,
    },
    indexCoverage: {
      label: 'Index Coverage',
      value: '71',
      delta: 'Bing · 27 of 38 indexed',
      tone: 'caution',
      description: '11 URLs are not indexed in Bing Webmaster Tools.',
      trend: [68, 69, 70, 71, 71],
    },
    providerScores: [
      { provider: 'openai', model: 'gpt-5.4', score: 58, cited: 4, total: 7 },
    ],
    queryCounts: { cited: 4, total: 7 },
    movementSummary: { gained: 0, lost: 0, tone: 'neutral', hasPreviousRun: false },
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
        detail: 'Answers prefer competitors with physician-specific evidence.',
        actionLabel: 'Gap',
        actionGroup: 'write',
        affectedPhrases: [{
          query: 'knee replacement surgeon westchester',
          evidenceId: 'evidence_northstar_knee',
          provider: 'openai',
          citationState: 'emerging',
        }],
      },
    ],
    visibilityEvidence: [
      {
        id: 'evidence_northstar_knee',
        query: 'knee replacement surgeon westchester',
        provider: 'openai',
        model: 'gpt-5.4',
        location: null,
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
        runHistory: mockHistory(['not-cited', 'not-cited', 'not-cited', 'cited']),
      },
    ],
    competitors: [
      {
        id: 'competitor_northstar_regional',
        domain: 'regionaljointcare.com',
        citationCount: 5,
        totalQueries: 7,
        pressureLabel: 'High',
        citedQueries: ['knee replacement', 'hip surgery', 'joint pain treatment', 'orthopedic surgeon', 'sports medicine'],
        movement: 'Winning broad treatment prompts',
        notes: 'Heavy physician proof and patient-story content.',
      },
    ],
    recentRuns: [runNorthstarVisibility],
    suggestedQueries: {
      rows: [],
      totalCandidates: 0,
      skippedAlreadyTracked: 0,
    },
  },
]

const baseDashboard: DashboardVm = {
  portfolioOverview: {
    projects: [
      {
        project: projects[0],
        visibilityScore: 61,
        visibilityDelta: '-8 this week',
        visibilityTone: 'caution',
        lastRun: runCitypointVisibility,
        insight: 'Lost emergency-intent citations after competitors refreshed availability pages.',
        trend: [73, 71, 69, 66, 61],
        competitorPressureLabel: 'High',
      },
      {
        project: projects[1],
        visibilityScore: 74,
        visibilityDelta: '+2 this week',
        visibilityTone: 'positive',
        lastRun: runHarborVisibility,
        insight: 'Practice-area consolidation is stabilizing branded and informational prompts.',
        trend: [68, 70, 71, 73, 74],
        competitorPressureLabel: 'Moderate',
      },
      {
        project: projects[2],
        visibilityScore: 58,
        visibilityDelta: 'Run in progress',
        visibilityTone: 'caution',
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
    recentRuns: [runCitypointQueued, runNorthstarVisibility, runCitypointVisibility],
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
        id: 'providers',
        label: 'Providers',
        tone: 'positive',
        detail: '2 of 3 configured',
        meta: 'Gemini · OpenAI',
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
        guidance: 'Required before any answer-visibility run can start.',
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
    queryImportState: {
      mode: 'paste',
      queryCount: 18,
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
    providerStatuses: [
      {
        name: 'Gemini',
        model: 'gemini-2.5-flash',
        state: 'ready',
        detail: 'API key detected and conservative quota defaults are active.',
        quota: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
      },
      {
        name: 'OpenAI',
        model: 'gpt-5.4',
        state: 'ready',
        detail: 'API key configured.',
        quota: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
      },
      {
        name: 'Claude',
        model: 'claude-sonnet-4-6',
        state: 'needs-config',
        detail: 'API key is missing.',
      },
    ],
    google: {
      state: 'ready',
      detail: 'Google OAuth app credentials are configured. Project-level GSC connections can be created from the dashboard.',
    },
    bing: {
      state: 'needs-config',
      detail: 'Bing Webmaster Tools API key is not configured yet.',
    },
    selfHostNotes: [
      'Configuration is stored in ~/.canonry/config.yaml.',
      'The local config file is the source of truth for authentication credentials.',
      'Google OAuth app credentials and per-domain Google tokens are stored in local config, not the database.',
      'Database is SQLite at ~/.canonry/data.db.',
      'API key was auto-generated during canonry init.',
    ],
    bootstrapNote: 'Use the UI, CLI, or ~/.canonry/config.yaml to manage settings. Authentication credentials persist to local config.',
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
        detail: 'Start the guided setup flow to add a domain, import queries, and launch the first run.',
        actionLabel: 'Open setup',
        href: '/setup',
      },
    ]
    dashboard.portfolioOverview.recentRuns = []
    dashboard.portfolioOverview.emptyState = {
      title: 'No projects yet',
      detail: 'Canonry becomes useful after one project, a small query set, and one competitor list are in place.',
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
    dashboard.settings.providerStatuses = dashboard.settings.providerStatuses.map(p => ({
      ...p,
      state: 'needs-config' as const,
      detail: 'API key is missing, so answer-visibility sweeps are blocked.',
    }))
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
        actionLabel: 'Lost',
        actionGroup: 'investigate',
        affectedPhrases: project.visibilityEvidence
          .filter(e => e.citationState === 'lost')
          .slice(0, 5)
          .map(e => ({
            query: e.query,
            evidenceId: e.id,
            provider: e.provider || undefined,
            citationState: e.citationState,
          })),
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

/**
 * Cross-source evidence lookup for the modal listener in `App.tsx`.
 *
 * The slim `useDashboardOverview` hook intentionally leaves per-project
 * `visibilityEvidence` empty (see `queries/use-dashboard-overview.ts`).
 * The full evidence list lives on the per-project `commandCenter` built
 * by `useProjectDashboard`, which is what ProjectPage uses to render the
 * EvidenceTable whose "View" button writes `?evidenceId=…` into the URL.
 *
 * So the modal lookup tries the project-specific source first, then
 * falls back to the dashboard walk (still useful if the slim shape ever
 * starts carrying evidence for cross-project deep links).
 */
export function findEvidenceForModal(
  commandCenter: ProjectCommandCenterVm | null | undefined,
  dashboard: DashboardVm | null | undefined,
  evidenceId: string,
): { project: ProjectCommandCenterVm; evidence: CitationInsightVm } | undefined {
  if (commandCenter) {
    const evidence = commandCenter.visibilityEvidence.find((entry) => entry.id === evidenceId)
    if (evidence) {
      return { project: commandCenter, evidence }
    }
  }
  if (dashboard) {
    return findEvidenceById(dashboard, evidenceId)
  }
  return undefined
}
