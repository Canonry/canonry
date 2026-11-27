import { useEffect, useRef, useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { getApiV1ProjectsByNameQueriesQueryKey } from '@canonry/canonry-api-client/react-query'
import {
  ONBOARDING_FLOW_VERSION,
  bucketOnboardingCount,
  normalizeQueryText,
  uniqueQueryTexts,
  type OnboardingTelemetryEvent,
} from '@canonry/canonry-contracts'

import { generateQueries, heyClient, setQueries } from '../../api.js'
import type { PendingOnboardingTelemetryEvent } from '../../hooks/use-onboarding-telemetry.js'
import { onboardingErrorReason } from '../../lib/onboarding-telemetry.js'
import { isProjectDetailQuery } from '../../queries/mutations.js'

export type SetupQueries = ReturnType<typeof useSetupQueries>

/** Onboarding telemetry from one setup surface, as `useOnboardingTelemetry` returns it. */
export interface SetupTelemetry {
  onboardingSessionId: string
  emit: (event: PendingOnboardingTelemetryEvent<OnboardingTelemetryEvent>, dedupeKey?: string) => void
}

/** Where setup keeps a project's saved queries. */
export function setupSavedQueriesKey(projectName: string | undefined) {
  return ['setup', 'resume-queries', projectName] as const
}

/** Reads a project's saved queries again wherever they show, once setup saved them. */
export async function refreshSavedQueries(queryClient: QueryClient, projectName: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: getApiV1ProjectsByNameQueriesQueryKey({
        client: heyClient,
        path: { name: projectName },
      }),
    }),
    queryClient.invalidateQueries({ predicate: isProjectDetailQuery }),
    queryClient.invalidateQueries({ queryKey: setupSavedQueriesKey(projectName) }),
  ])
}

/**
 * The queries in a one-per-line list, each once. Lines match as the server's
 * query replace matches them (`normalizeQueryText`), keeping the first
 * spelling, so a count read from this is the number Save stores.
 */
function uniqueQueryLines(text: string): string[] {
  return uniqueQueryTexts(text.split('\n'))
}

/** Generated suggestions the list does not hold yet, and how many it already held. */
function newQuerySuggestions(currentText: string, suggestions: readonly string[]): { added: string[]; skipped: number } {
  const known = new Set(uniqueQueryLines(currentText).map(normalizeQueryText))
  const added: string[] = []
  let skipped = 0
  for (const suggestion of suggestions) {
    const query = suggestion.trim()
    const key = normalizeQueryText(query)
    if (!key) continue
    if (known.has(key)) {
      skipped += 1
      continue
    }
    known.add(key)
    added.push(query)
  }
  return { added, skipped }
}

/** The request an operator hands their own agent to research queries for this project. */
function queryResearchPrompt(projectName: string, domain: string): string {
  return `Help me choose AI Visibility queries for Canonry project ${JSON.stringify(projectName)} (${domain}).
1. Read the project, its existing tracked queries, and Agent Readiness findings. Ask about my customers, services, and locations if needed, then propose relevant customer queries.
2. Check the configured connection's capabilities, then use Canonry's Research flow to test a small approved batch. Retrieve saved answers and any available sources. Compare brand mentions separately from site citations; unavailable citation evidence is not a "not cited" result. Text-only routes can inform query research but cannot establish an AI Visibility baseline. Research does not add queries to tracking. If more candidates are needed, propose ICP Discovery separately.
3. Recommend a short list with reasons. Ask before provider usage. Once I approve, preserve existing queries and return the combined list, one query per line, for me to paste into setup. Do not change tracked queries or launch an AI Visibility check.`
}

/**
 * The query list a first check asks: typed or pasted, suggested by an engine,
 * or researched with the operator's agent, then saved as the project's tracked
 * queries. `SetupQueriesForm` shows it.
 */
export function useSetupQueries({
  projectName,
  initialText,
  initialSaved,
  generateProviders,
  research,
  telemetry,
  refreshAfterSave,
  onContinue,
}: {
  /** The project the list saves to; null until the wizard creates it. */
  projectName: string | null
  /** The list the form opens with: an unsaved draft, else the saved queries. */
  initialText: string
  /** Whether that list is the saved one. */
  initialSaved: boolean
  /** Ready engines that can suggest queries. */
  generateProviders: ReadonlyArray<{ name: string; displayName?: string; model?: string }>
  /** What the agent research prompt names. */
  research: { projectName: string; domain: string }
  telemetry: SetupTelemetry
  /** Reads the saved queries again once a save lands. */
  refreshAfterSave: (projectName: string) => Promise<unknown>
  /** Moves on with the saved list. */
  onContinue: () => void
}) {
  const queryClient = useQueryClient()
  const [text, setText] = useState(initialText)
  const [saved, setSaved] = useState(initialSaved)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [generated, setGenerated] = useState(false)
  // Suggestions the last Generate left out because the list already held them.
  const [generatedDuplicates, setGeneratedDuplicates] = useState(0)
  // Generate appends after a provider round trip; read the list as it is then.
  const latestText = useRef(text)
  useEffect(() => { latestText.current = text }, [text])
  const [selectedProvider, setSelectedProvider] = useState(generateProviders[0]?.name ?? '')
  const [generateCount, setGenerateCount] = useState(5)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [researchPromptCopied, setResearchPromptCopied] = useState(false)
  const [researchCopyError, setResearchCopyError] = useState(false)
  const parsed = uniqueQueryLines(text)
  const researchPrompt = queryResearchPrompt(research.projectName, research.domain)

  useEffect(() => {
    if (generateProviders.length === 0) {
      setSelectedProvider('')
      return
    }
    if (!generateProviders.some(provider => provider.name === selectedProvider)) {
      setSelectedProvider(generateProviders[0]!.name)
    }
  }, [generateProviders, selectedProvider])

  const save = async () => {
    if (!projectName) return
    const queries = parsed
    if (queries.length === 0) return
    setSaving(true)
    setError(null)
    try {
      const savedQueries = await setQueries(projectName, queries)
      queryClient.setQueryData(setupSavedQueriesKey(projectName), savedQueries)
      setText(savedQueries.map(query => query.query).join('\n'))
      setSaved(true)
      await refreshAfterSave(projectName)
      telemetry.emit({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId: telemetry.onboardingSessionId,
        event: 'onboarding.step_completed',
        step: 'queries',
        method: generated ? 'generated' : 'manual',
        countBucket: bucketOnboardingCount(savedQueries.length),
      }, 'onboarding.step_completed:queries')
      onContinue()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save queries')
      telemetry.emit({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId: telemetry.onboardingSessionId,
        event: 'onboarding.blocked',
        step: 'queries',
        action: 'save',
        reasonCode: 'query_save_failed',
      }, 'onboarding.blocked:queries:query_save_failed')
    } finally {
      setSaving(false)
    }
  }

  const generate = async () => {
    if (!projectName || !selectedProvider) return
    setGenerating(true)
    setGenerateError(null)
    setGeneratedDuplicates(0)
    try {
      const result = await generateQueries(projectName, selectedProvider, generateCount)
      const currentText = latestText.current
      const { added, skipped } = newQuerySuggestions(currentText, result.queries)
      if (added.length > 0) {
        setText(currentText.trim() ? `${currentText.trimEnd()}\n${added.join('\n')}` : added.join('\n'))
        setGenerated(true)
      }
      setGeneratedDuplicates(skipped)
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to generate queries')
      telemetry.emit({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId: telemetry.onboardingSessionId,
        event: 'onboarding.blocked',
        step: 'queries',
        action: 'generate_queries',
        reasonCode: onboardingErrorReason(err, 'unknown'),
      }, 'onboarding.blocked:queries:generate')
    } finally {
      setGenerating(false)
    }
  }

  const copyResearchPrompt = async () => {
    setResearchCopyError(false)
    try {
      await navigator.clipboard.writeText(researchPrompt)
      setResearchPromptCopied(true)
    } catch {
      setResearchCopyError(true)
    }
  }

  return {
    /** The list as typed. */
    text,
    setText,
    /** The list is the saved one, shown read-only until Edit queries. */
    saved,
    setSaved,
    error,
    setError,
    saving,
    /** Each query once, as Save stores them. */
    parsed,
    save,
    /** Moves on with the list already saved. */
    continueWithSaved: () => {
      telemetry.emit({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId: telemetry.onboardingSessionId,
        event: 'onboarding.step_completed',
        step: 'queries',
        method: 'existing',
        countBucket: bucketOnboardingCount(parsed.length),
      }, 'onboarding.step_completed:queries')
      onContinue()
    },
    generateProviders,
    selectedProvider,
    setSelectedProvider,
    generateCount,
    setGenerateCount,
    generating,
    generateError,
    generatedDuplicates,
    generate,
    researchPrompt,
    researchPromptCopied,
    researchCopyError,
    copyResearchPrompt,
  }
}
