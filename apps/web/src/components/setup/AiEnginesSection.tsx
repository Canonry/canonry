import { Link } from '@tanstack/react-router'
import { ProviderNames, isOpenRouterRoute, openRouterRouteModel } from '@canonry/canonry-contracts'

import { normalizeProviderName } from '../../lib/ai-visibility-provider-readiness.js'
import { ProjectEngineSettingsSection } from '../project/ProjectEngineSettingsSection.js'
import { ProviderConfigForm } from '../settings/ProviderConfigForm.js'
import { PROVIDER_CONNECTION_TEST_COPY, ProviderConnectionTestLine } from '../settings/ProviderConnectionTest.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { OpenRouterModelPicker } from '../shared/OpenRouterModelPicker.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { Button } from '../ui/button.js'
import type { AiEngineSetup } from './use-ai-engine-setup.js'

/** Compact for a mouse on a desktop; 44px tall for touch and narrow screens. */
export const SETUP_TOUCH_TARGET = 'pointer-coarse:min-h-11 max-md:min-h-11'

/**
 * What each provider is and what connecting it takes, as its adapter
 * (`packages/provider-*`) and `docs/providers/` describe it.
 */
const PROVIDER_CONNECT_GUIDANCE: Readonly<Partial<Record<string, string>>> = {
  [ProviderNames.gemini]: "Google's Gemini models, answering with Google Search. Needs an API key.",
  [ProviderNames.openai]: "OpenAI's GPT models, answering with web search. Needs an API key.",
  [ProviderNames.claude]: "Anthropic's Claude models, answering with web search. Needs an API key.",
  [ProviderNames.perplexity]: 'Perplexity, answering with web search. Needs an API key.',
  [ProviderNames.muse]: "Meta's Muse models, answering with web search. Needs a Meta Model API key.",
  [ProviderNames.openrouter]: 'Models from several makers through one API key. Save the key, then choose which models to check.',
  [ProviderNames.local]: 'A model you run on an OpenAI-compatible server, without web search. Needs its base URL; an API key is optional.',
}

/**
 * Every engine the first connection can choose, as one line. The form opens on
 * one engine, so this says the others exist and that more can follow.
 */
function engineChoicesHint(providers: readonly { name: string; displayName?: string }[]): string | null {
  if (providers.length < 2) return null
  const names = providers
    .filter(provider => normalizeProviderName(provider.name) !== ProviderNames.local)
    .map(provider => normalizeProviderName(provider.name) === ProviderNames.openrouter
      ? `${provider.displayName ?? provider.name} (many models with one key)`
      : provider.displayName ?? provider.name)
  if (providers.some(provider => normalizeProviderName(provider.name) === ProviderNames.local)) names.push('models you run yourself')
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('')
  return `Works with ${list}. Start with one and add more any time in Settings.`
}

/**
 * The "AI engines" section of setup: which engines are connected and proven,
 * and the provider form that connects one. An administrator connects and
 * tests engines here; any other writer sees readiness only.
 */
export function AiEnginesSection({ engines, headingLevel, separated = false }: {
  engines: AiEngineSetup
  /** h2 on a setup page; h3 inside the tracker's row, whose title is the h2. */
  headingLevel: 'h2' | 'h3'
  /** A rule below the section, when the next step shares its surface. */
  separated?: boolean
}) {
  const Heading = headingLevel
  const headingClassName = headingLevel === 'h3' ? 'text-heading-16 text-heading' : 'text-heading-20 text-heading'
  const rule = separated ? ' border-b border-default pb-6 mb-6' : ''
  const {
    providerReadiness,
    providerReadinessFailed,
    connectionStatus,
    providerToConfigure,
  } = engines

  if (!engines.isAdmin) {
    return (
      <section aria-labelledby="setup-provider-heading" className={`space-y-2${rule}`}>
        <div className="flex flex-wrap items-center gap-3">
          <Heading id="setup-provider-heading" className={headingClassName}>AI engines</Heading>
          {providerReadinessFailed ? null : (
            <span role="status" className="flex items-center gap-2">
              <ToneBadge tone={providerReadiness === true ? connectionStatus.tone : 'neutral'}>
                {providerReadiness === true ? connectionStatus.label : providerReadiness === false ? 'Not connected' : 'Checking'}
              </ToneBadge>
              <InfoTooltip text={providerReadiness === true
                ? 'Connection settings are saved. An administrator can test the connection, and a successful check also confirms access.'
                : providerReadiness === false
                  ? 'Ask an administrator to connect an AI engine for this project. You can save queries now.'
                  : 'Checking for a connected AI engine. An administrator manages provider settings. You can save queries now.'} />
            </span>
          )}
        </div>
        {providerReadinessFailed ? (
          <p role="alert" className="text-copy-14 text-negative">Provider connections could not be checked. Try again.</p>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={SETUP_TOUCH_TARGET}
          disabled={engines.projectReadinessFetching}
          onClick={engines.refreshProjectReadiness}
        >
          {providerReadinessFailed ? 'Retry provider check' : 'Refresh connections'}
        </Button>
      </section>
    )
  }

  const engineChoices = engineChoicesHint(engines.configurableProviders)
  const providerGuidance = providerToConfigure ? PROVIDER_CONNECT_GUIDANCE[normalizeProviderName(providerToConfigure.name)] : undefined
  const refreshAction = engines.showRefreshConnections ? (
    <Button type="button" variant="ghost" size="sm" className={SETUP_TOUCH_TARGET} onClick={engines.refreshConnections}>
      Refresh connections
    </Button>
  ) : null
  const { connectionNames, connectionTests, runnableApiProviders } = engines
  return (
    <section aria-labelledby="setup-provider-heading" className={`space-y-3${rule}`}>
      <div className="flex flex-wrap items-center gap-3">
        <Heading id="setup-provider-heading" className={headingClassName}>AI engines</Heading>
        <ToneBadge tone={engines.openRouterModelsNeeded ? 'caution' : providerReadiness === true ? connectionStatus.tone : 'neutral'}>
          {providerReadiness === true ? connectionStatus.label : engines.openRouterModelsNeeded ? 'Choose models' : engines.providerNeedsConnection ? 'Not connected' : 'Checking'}
        </ToneBadge>
        <InfoTooltip text={providerReadiness === true
          ? runnableApiProviders.length > 0
            ? connectionTests.allConnected
              ? 'A test reached each provider with the saved settings. Checks and Research use your provider account and its quota.'
              : 'Connection settings are saved, but access and quota are not verified. Test the connection before your first check. Checks and Research use your provider account.'
            : 'ChatGPT in Chrome runs AI Visibility checks. Query Research needs an API provider.'
          : engines.openRouterModelsNeeded
            ? 'OpenRouter is connected. Choose the models your AI Visibility checks ask. You can save queries now.'
          : engines.providerNeedsConnection
            ? 'AI Visibility checks need an AI engine. You can save queries now and connect one later.'
            : 'Checking connected AI engines. You can choose queries meanwhile.'} />
      </div>
      {engines.providerNeedsConnection && engineChoices ? <p className="max-w-prose text-copy-14 text-secondary">{engineChoices}</p> : null}
      {providerReadiness === true && (runnableApiProviders.length > 0 || engines.cdpConfigured === true) ? (
        <ul aria-label="Saved AI engines" className="divide-y divide-default">
          {runnableApiProviders.map(provider => {
            const routed = isOpenRouterRoute(provider.name)
            const label = provider.displayName ?? provider.name
            const effectiveModel = engines.projectModel(provider.name) ?? provider.model
            return (
              <li key={provider.name} className="flex min-h-11 items-center justify-between gap-3 px-3.5 py-2 text-label-14" title={routed ? openRouterRouteModel(provider.name) : undefined}>
                <span className="min-w-0 truncate text-heading">{routed ? label.replace(/ via OpenRouter$/, '') : label}</span>
                <span className="shrink-0 text-secondary">{routed ? 'OpenRouter' : effectiveModel ?? ''}</span>
              </li>
            )
          })}
          {runnableApiProviders.length === 0 ? <li className="flex min-h-11 items-center px-3.5 py-2 text-label-14 text-heading">ChatGPT in Chrome</li> : null}
        </ul>
      ) : null}
      {providerReadiness === true && connectionNames.length > 0 && !engines.providerFormVisible ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button type="button" variant="outline" size="sm" className={SETUP_TOUCH_TARGET} disabled={connectionTests.testing} aria-describedby={engines.connectionTestNotice ? engines.connectionTestNoticeId : undefined} onClick={connectionTests.test}>
              {connectionTests.testing
                ? PROVIDER_CONNECTION_TEST_COPY.testing
                : connectionNames.length > 1 ? PROVIDER_CONNECTION_TEST_COPY.testMany : PROVIDER_CONNECTION_TEST_COPY.testOne}
            </Button>
            {engines.connectionTestNotice ? <p id={engines.connectionTestNoticeId} className="text-copy-14 text-secondary">{engines.connectionTestNotice}</p> : null}
          </div>
          <div role="status">
            {connectionTests.records.some(record => record !== undefined) ? (
              <ul aria-label={PROVIDER_CONNECTION_TEST_COPY.results} className="space-y-1">
                {connectionNames.map((name, index) => {
                  const record = connectionTests.records[index]
                  return record ? <li key={name}><ProviderConnectionTestLine record={record} label={engines.connectionLabel(name)} /></li> : null
                })}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
      {engines.inlineModelPicker ? (
        engines.openRouterCatalog ? (
          <OpenRouterModelPicker
            inline
            catalog={engines.openRouterCatalog}
            selected={engines.projectProviders}
            // Explicit engines keep no model override for engines left out, as
            // Save engines does, and an OpenRouter model takes none of its own.
            onAdd={routes => engines.saveEngines({ providers: routes, providerModels: {} })}
          />
        ) : engines.openRouterCatalogPending ? (
          <p role="status" className="text-copy-14 text-secondary">Loading OpenRouter models…</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-copy-14 text-negative">Couldn't load OpenRouter's model list.</p>
            <Button type="button" variant="outline" size="sm" onClick={engines.retryOpenRouterCatalog}>Retry</Button>
          </div>
        )
      ) : null}
      {engines.providerNeedsConnection || engines.showProviderConfig ? (
        providerToConfigure ? (
          <div>
            <ProviderConfigForm
              key={providerToConfigure.name}
              compact
              configured={providerToConfigure.state === 'configured' || providerToConfigure.state === 'ready'}
              onDirtyChange={engines.setProviderDirty}
              onBusyChange={engines.setProviderBusy}
              onCancel={engines.cancelProviderForm}
              leadingField={(
                <div className="min-w-0 space-y-1.5">
                  <label className="block text-label-14-strong text-secondary" htmlFor="setup-provider">Provider to connect</label>
                  <select
                    ref={engines.providerSelectorRef}
                    id="setup-provider"
                    className="setup-input"
                    aria-describedby={providerGuidance ? 'setup-provider-guidance' : undefined}
                    value={providerToConfigure.name}
                    onChange={event => engines.chooseProvider(event.target.value)}
                  >
                    {engines.configurableProviders.map(provider => (
                      <option key={provider.name} value={provider.name}>{provider.displayName ?? provider.name}</option>
                    ))}
                  </select>
                  {providerGuidance ? <p id="setup-provider-guidance" className="text-copy-13 text-secondary">{providerGuidance}</p> : null}
                </div>
              )}
              secondaryActions={refreshAction}
              offerFreeTier={engines.providerNeedsConnection}
              saveLabel={engines.openRouterModelsFollowSave && normalizeProviderName(providerToConfigure.name) === ProviderNames.openrouter ? 'Save and choose models' : undefined}
              providerName={providerToConfigure.name}
              keyUrl={providerToConfigure.keyUrl}
              modelHint={providerToConfigure.modelHint}
              defaultModel={providerToConfigure.defaultModel}
              onSaved={engines.providerSaved}
            />
          </div>
        ) : (
          <p className="max-w-prose text-copy-14 text-secondary">
            {engines.projectProviders.length > 0
              ? `This project's provider selection is ${engines.projectProviders.join(', ')}. Configure an allowed provider in Settings, or change the selection in project Settings.`
              : 'Provider configuration is unavailable here. Open Settings to connect an answer engine, then check again.'}
          </p>
        )
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {(providerReadiness === true || engines.openRouterModelsNeeded) && !engines.showProviderConfig && providerToConfigure ? (
          <Button type="button" variant="ghost" size="sm" className="-ml-3 text-button-14" onClick={() => engines.setShowProviderConfig(true)}>
            {engines.canConnectAnotherEngine ? 'Connect another engine' : 'Change engine settings'}
          </Button>
        ) : null}
        {!providerToConfigure || engines.cdpConfigured === true ? (
          <Button type="button" variant="outline" size="sm" asChild>
            <Link to="/settings" target="_blank" rel="noopener noreferrer">Open provider settings</Link>
          </Button>
        ) : null}
        {!engines.providerFormVisible && !engines.inlineModelPicker ? refreshAction : null}
      </div>
    </section>
  )
}

/** Changes the project's engines before its first check, once OpenRouter is connected. */
export function ChangeEngines({ engines }: { engines: AiEngineSetup }) {
  if (!engines.canChangeEngines || !engines.engineProject) return null
  return (
    <details className="mb-4">
      <summary className="cursor-pointer py-2 text-label-14 text-link">Change engines</summary>
      <ProjectEngineSettingsSection project={engines.engineProject} onSave={engines.saveEngines} />
    </details>
  )
}
