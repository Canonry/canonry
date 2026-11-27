import { useCallback, useId, useRef, useState, type RefCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getApiV1CdpStatusOptions, getApiV1ProjectsByNameMeasurementSetupOptions } from '@canonry/canonry-api-client/react-query'
import { isOpenRouterRoute, openRouterRouteModel, providerConnectionName, type OnboardingBlockReason } from '@canonry/canonry-contracts'

import { fetchSettings, heyClient, updateProject, type ApiProject } from '../../api.js'
import { useAccount } from '../../contexts/account-context.js'
import { useUnsavedChanges } from '../../hooks/use-unsaved-changes.js'
import { CDP_PROVIDER_NAME, normalizeProviderName, resolveAiVisibilityProviderReadiness } from '../../lib/ai-visibility-provider-readiness.js'
import { getLaunchBlockedReason } from '../../lib/health-helpers.js'
import { onboardingSystemBlockReason } from '../../lib/onboarding-telemetry.js'
import { catalogRouteFamilies } from '../../lib/provider-routes.js'
import { providerDisplayName } from '../../lib/visibility-trend-helpers.js'
import { useProviderConnectionTests } from '../../queries/provider-connection-tests.js'
import type { HealthSnapshot, SettingsVm } from '../../view-models.js'
import { PROVIDER_CONNECTION_TEST_COPY, connectionUsesProviderAccount, providerConnectionStatus } from '../settings/ProviderConnectionTest.js'

export type AiEngineSetup = ReturnType<typeof useAiEngineSetup>

/**
 * The AI engines a setup surface can run its first check on: which are ready,
 * how far each saved connection is proven, and the provider form that connects
 * one. The wizard, the project's Set up AI Visibility page and the setup
 * tracker's AI Visibility panel all show it through `AiEnginesSection`.
 */
export function useAiEngineSetup({ settings, project, projectScoped, refresh }: {
  /** Provider settings as an administrator's settings read lists them; other accounts see none. */
  settings: SettingsVm
  /** The project as last read; null until the wizard creates one. */
  project: ApiProject | null
  /** Setup for one existing project (its page or the tracker's panel), not the whole wizard. */
  projectScoped: boolean
  /** Reads provider settings and the project again: after a save, and on Refresh connections. */
  refresh: () => Promise<unknown>
}) {
  const { isAdmin } = useAccount()
  // Engines saved here win over a project read taken before the save.
  const [engineProject, setEngineProject] = useState<ApiProject | null>(project)
  const openRouterConnected = settings.providerStatuses.some(provider => provider.name === 'openrouter' && (provider.state === 'ready' || provider.state === 'configured'))
  const projectProviders = (engineProject?.providers ?? project?.providers ?? []).map(normalizeProviderName)
  // OpenRouter routes are named from OpenRouter's catalog (the administrator
  // settings read), so setup shows a readable model name via OpenRouter rather
  // than the raw model ID.
  const settingsCatalogQuery = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    staleTime: 60_000,
    enabled: isAdmin && openRouterConnected && projectProviders.some(isOpenRouterRoute),
  })
  const readyProviders = [
    // A search answer service runs only where a project picks its profiles, so it never makes setup ready.
    ...settings.providerStatuses.filter(provider => (provider.state === 'ready' || provider.state === 'configured') && provider.name !== 'openrouter' && provider.kind !== 'answer-service'),
    ...(openRouterConnected ? projectProviders.filter(isOpenRouterRoute).map(name => ({ name, displayName: providerDisplayName(name, settingsCatalogQuery.data?.providerCatalog), model: openRouterRouteModel(name), state: 'ready' as const, detail: 'OpenRouter model configured.' })) : []),
  ]
  const runnableApiProviders = readyProviders.filter(provider => (
    projectProviders.length === 0 || projectProviders.includes(normalizeProviderName(provider.name))
  ))
  const configuredApiProviders = readyProviders.map(provider => normalizeProviderName(provider.name))
  const selectedApiProviderReady = runnableApiProviders.length > 0
  const selectionCanUseCdp = projectProviders.length === 0 || projectProviders.includes(CDP_PROVIDER_NAME)
  // Scoped writers cannot read the administrator's provider catalog. The
  // project-readable setup response exposes readiness without credentials or
  // instance capability inventory, using the server's exact run preflight.
  const usesProjectProviderReadiness = projectScoped && !isAdmin
  const projectName = project?.name
  const projectProviderQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementSetupOptions({
      client: heyClient,
      path: { name: projectName ?? '' },
    }),
    enabled: usesProjectProviderReadiness && Boolean(projectName),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    retry: false,
  })
  const projectProviderReady = projectProviderQuery.data?.answerVisibilityProviderReady
  const providerReadinessFailed = usesProjectProviderReadiness && (
    projectProviderQuery.isError
    || (projectProviderQuery.isSuccess && typeof projectProviderReady !== 'boolean')
  )
  const cdpStatusQuery = useQuery({
    ...getApiV1CdpStatusOptions({ client: heyClient }),
    enabled: !usesProjectProviderReadiness && selectionCanUseCdp && !selectedApiProviderReady,
    staleTime: 60_000,
    retry: false,
  })
  // A registered CDP adapter remains a runnable provider when Chrome is
  // temporarily disconnected. `browserVersion` is absent only when no adapter
  // was registered, matching the project-page readiness contract.
  const cdpConfigured = !selectionCanUseCdp
    ? false
    : cdpStatusQuery.isSuccess
      ? typeof cdpStatusQuery.data.browserVersion === 'string'
      : cdpStatusQuery.isError ? false : undefined
  const providerReadiness = usesProjectProviderReadiness
    ? projectProviderQuery.isSuccess && projectProviderQuery.isFetchedAfterMount && !projectProviderQuery.isFetching
      ? projectProviderReady
      : undefined
    : resolveAiVisibilityProviderReadiness({
      projectProviders,
      configuredApiProviders,
      cdpConfigured,
    })
  const openRouterModelsNeeded = openRouterConnected && projectProviders.length === 0 && providerReadiness === false
  const providerNeedsConnection = providerReadiness === false && !openRouterModelsNeeded
  // An administrator picks OpenRouter models right in the provider step, so
  // connecting OpenRouter finishes here as a direct provider does. The catalog
  // is the administrator settings read the project Answer engines section uses.
  const inlineModelPicker = projectScoped && isAdmin && openRouterModelsNeeded
  // Saving a first OpenRouter key opens that picker in this step; with another
  // engine already connected, the models are chosen later instead.
  const openRouterModelsFollowSave = projectScoped && isAdmin && projectProviders.length === 0 && providerReadiness === false
  const openRouterSettingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    staleTime: 60_000,
    enabled: inlineModelPicker,
  })
  const openRouterCatalog = (openRouterSettingsQuery.data?.providerCatalog ?? []).find(provider => provider.name === 'openrouter')
  const runnableProviderCount = runnableApiProviders.length + (cdpConfigured === true ? 1 : 0)
  // The saved connections behind the listed engines: every route of a routed
  // family (OpenRouter models, answer-service profiles) shares its connection.
  const engineRouteFamilies = catalogRouteFamilies(settingsCatalogQuery.data?.providerCatalog ?? [])
  const connectionNames = [...new Set([
    ...runnableApiProviders.map(provider => providerConnectionName(normalizeProviderName(provider.name), engineRouteFamilies)),
    ...(runnableApiProviders.length === 0 && cdpConfigured === true ? [CDP_PROVIDER_NAME] : []),
  ])]
  const connectionStatusOf = (name: string) => settings.providerStatuses.find(provider => normalizeProviderName(provider.name) === name)
  // An administrator's settings read carries each connection's revision and stored last test.
  const connectionTests = useProviderConnectionTests(connectionNames.map(name => {
    const status = connectionStatusOf(name)
    return {
      name,
      ...(status?.revision !== undefined ? { revision: status.revision } : {}),
      ...(status?.lastTest !== undefined ? { lastTest: status.lastTest } : {}),
    }
  }))
  const connectionLabel = (name: string): string => {
    if (name === CDP_PROVIDER_NAME) return 'ChatGPT in Chrome'
    const status = connectionStatusOf(name)
    return status?.displayName ?? status?.name ?? name
  }
  // A test of an API connection reaches the provider on the operator's account; Chrome's does not.
  const connectionTestNoticeId = useId()
  const connectionTestNotice = connectionNames.includes(CDP_PROVIDER_NAME)
    ? null
    : PROVIDER_CONNECTION_TEST_COPY.sends(connectionNames.map(name => ({ label: connectionLabel(name), usesAccount: connectionUsesProviderAccount(name) })))
  // Connected only after a passing test of every listed connection; saved settings alone prove nothing.
  const connectionStatus = providerConnectionStatus(connectionTests.results)

  const [configuringProvider, setConfiguringProvider] = useState('')
  const restoreProviderFocus = useRef(false)
  const scrollProviderFocus = useRef(false)
  const providerSelectorRef = useCallback<RefCallback<HTMLSelectElement>>((node) => {
    if (!node || !restoreProviderFocus.current) return
    // The keyed form must reset credentials and advanced fields on switch.
    // Restore only focus the user already had, not focus after background reads.
    restoreProviderFocus.current = false
    node.focus({ preventScroll: !scrollProviderFocus.current })
    scrollProviderFocus.current = false
  }, [])
  const [showProviderConfig, setShowProviderConfig] = useState(false)
  const [providerDirty, setProviderDirty] = useState(false)
  const [providerBusy, setProviderBusy] = useState(false)
  const providerGuard = useUnsavedChanges(providerDirty, providerBusy)
  const configurableProviders = settings.providerStatuses.filter(provider => (
    normalizeProviderName(provider.name) !== CDP_PROVIDER_NAME
    && provider.kind !== 'answer-service'
    && (projectProviders.length === 0 || projectProviders.includes(normalizeProviderName(provider.name)) || (provider.name === 'openrouter' && projectProviders.some(isOpenRouterRoute)))
  ))
  const isUnconnected = (provider: { state: string }) => provider.state !== 'ready' && provider.state !== 'configured'
  // The provider form opens on an unconnected engine when there is one; with
  // none left it can only edit a saved connection, and its button says so.
  const canConnectAnotherEngine = configurableProviders.some(isUnconnected)
  const providerToConfigure = configurableProviders.find(provider => provider.name === configuringProvider)
    ?? configurableProviders.find(isUnconnected)
    ?? configurableProviders.at(0)

  // The project's engines, saved through the same project update the Answer
  // engines section uses. The returned project drives provider readiness here.
  const saveEngines = async (next: Pick<ApiProject, 'providers' | 'providerModels'>) => {
    const name = engineProject?.name
    if (!name) throw new Error('Create a project before choosing models.')
    const saved = await updateProject(name, next)
    setEngineProject(saved)
    await refresh()
  }

  return {
    isAdmin,
    /** The project's engines as last saved here, else as read. */
    engineProject,
    setEngineProject,
    saveEngines,
    openRouterConnected,
    openRouterCatalog,
    openRouterCatalogPending: openRouterSettingsQuery.isPending,
    retryOpenRouterCatalog: () => { void openRouterSettingsQuery.refetch() },
    projectProviders,
    /** Ready API engines this project may use. */
    runnableApiProviders,
    runnableProviderCount,
    cdpConfigured,
    usesProjectProviderReadiness,
    /** True once an engine this project may use is ready; undefined while that is being checked. */
    providerReadiness,
    providerReadinessFailed,
    projectReadinessFetching: projectProviderQuery.isFetching,
    refreshProjectReadiness: () => { void projectProviderQuery.refetch() },
    openRouterModelsNeeded,
    providerNeedsConnection,
    inlineModelPicker,
    openRouterModelsFollowSave,
    connectionNames,
    connectionTests,
    connectionLabel,
    connectionTestNotice,
    connectionTestNoticeId,
    connectionStatus,
    /** The model a listed engine runs: the project's own choice first. */
    projectModel: (providerName: string) => engineProject?.providerModels[providerName] ?? project?.providerModels[providerName],
    configurableProviders,
    canConnectAnotherEngine,
    providerToConfigure,
    providerFormVisible: (providerNeedsConnection || showProviderConfig) && !!providerToConfigure,
    showProviderConfig,
    setShowProviderConfig,
    setProviderDirty,
    setProviderBusy,
    providerGuard,
    providerSelectorRef,
    /** OpenRouter models can still change before the first check. */
    canChangeEngines: isAdmin && openRouterConnected && !inlineModelPicker,
    showRefreshConnections: providerReadiness !== true || cdpConfigured === true,
    refreshConnections: () => {
      void refresh()
      if (selectionCanUseCdp) void cdpStatusQuery.refetch()
      if (inlineModelPicker) void openRouterSettingsQuery.refetch()
    },
    chooseProvider: (nextProvider: string) => {
      if (nextProvider === providerToConfigure?.name) return
      providerGuard.request(() => {
        restoreProviderFocus.current = true
        setProviderDirty(false)
        setConfiguringProvider(nextProvider)
      })
    },
    cancelProviderForm: () => providerGuard.request(() => { setProviderDirty(false); setShowProviderConfig(false) }),
    /** Closes the form without asking; callers ask first through `providerGuard`. */
    closeProviderForm: () => { setProviderDirty(false); setShowProviderConfig(false) },
    providerSaved: () => {
      setProviderDirty(false)
      setShowProviderConfig(false)
      void refresh()
    },
    /** Reopens the saved connection a failed check used, with focus on its provider. */
    repairConnection: () => {
      restoreProviderFocus.current = true
      scrollProviderFocus.current = true
      setConfiguringProvider(runnableApiProviders.at(0)?.name ?? providerToConfigure?.name ?? '')
      setShowProviderConfig(true)
    },
  }
}

/**
 * Why the first check cannot start yet, as far as the instance and its engines
 * go: the system reason telemetry reports, and the sentence the launch shows.
 */
export function firstCheckReadiness(health: HealthSnapshot, settings: SettingsVm, engines: Pick<AiEngineSetup, 'providerReadiness' | 'providerReadinessFailed'>): {
  systemBlockReason: OnboardingBlockReason | undefined
  blockedReason: string | undefined
} {
  const systemBlockReason = onboardingSystemBlockReason({
    apiReady: health.apiStatus.state === 'ok',
    databaseConfigured: health.apiStatus.databaseConfigured,
    workerReady: health.workerStatus.state === 'ok',
    // A pending CDP read is not yet a confirmed provider failure. The explicit
    // readiness message below keeps launch disabled until it settles.
    providerReady: engines.providerReadiness !== false,
  })
  const blockedReason = systemBlockReason && systemBlockReason !== 'no_provider'
    ? getLaunchBlockedReason(health, settings)
    : engines.providerReadinessFailed
      ? 'Provider connections could not be checked. Try again.'
      : engines.providerReadiness === undefined
        ? 'Checking provider connections before launch.'
        : systemBlockReason === 'no_provider'
          ? 'Launch is blocked until a provider allowed by this project is configured.'
          : undefined
  return { systemBlockReason, blockedReason }
}
