import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { Button } from '../ui/button.js'
import { updateProviderConfig } from '../../api.js'
import { addToast } from '../../lib/toast-store.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { invalidateProjectQueryDomain } from '../../queries/query-invalidation.js'

export function ProviderConfigForm({ providerName, keyUrl, modelHint, compact = false, leadingField, secondaryActions, onSaved }: {
  providerName: string
  keyUrl?: string
  modelHint?: string
  /** Keep optional tuning out of the first-run provider connection path. */
  compact?: boolean
  /** An adjacent provider selector for the compact connection form. */
  leadingField?: ReactNode
  /** Keep connection actions together in the compact form footer. */
  secondaryActions?: ReactNode
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const isLocal = providerName.toLowerCase() === 'local'
  const showGeminiFreeTier = compact && providerName.toLowerCase() === 'gemini' && !!keyUrl
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [maxConcurrency, setMaxConcurrency] = useState('')
  const [maxPerMinute, setMaxPerMinute] = useState('')
  const [maxPerDay, setMaxPerDay] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const canSave = isLocal ? baseUrl.trim().length > 0 : apiKey.trim().length > 0

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    setSuccess(false)
    try {
      const parseQuotaField = (s: string): number | undefined => {
        const n = parseInt(s.trim(), 10)
        return Number.isFinite(n) && n > 0 ? n : undefined
      }
      const quota: { maxConcurrency?: number; maxRequestsPerMinute?: number; maxRequestsPerDay?: number } = {}
      const maxConcurrencyVal = parseQuotaField(maxConcurrency)
      if (maxConcurrencyVal !== undefined) quota.maxConcurrency = maxConcurrencyVal
      const maxPerMinuteVal = parseQuotaField(maxPerMinute)
      if (maxPerMinuteVal !== undefined) quota.maxRequestsPerMinute = maxPerMinuteVal
      const maxPerDayVal = parseQuotaField(maxPerDay)
      if (maxPerDayVal !== undefined) quota.maxRequestsPerDay = maxPerDayVal
      await updateProviderConfig(providerName.toLowerCase(), {
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(Object.keys(quota).length > 0 ? { quota } : {}),
      })
      setApiKey('')
      setBaseUrl('')
      setModel('')
      setMaxConcurrency('')
      setMaxPerMinute('')
      setMaxPerDay('')
      setSuccess(true)
      // A new key, model or endpoint lifts that provider's hold on every
      // project, so their notices and sweep buttons must not wait for staleness.
      void invalidateProjectQueryDomain(queryClient, 'runAdmission')
      addToast({
        title: 'Provider updated',
        detail: `${providerName} configuration saved.`,
        tone: 'positive',
        dedupeKey: `settings:provider:${providerName}`,
        dedupeMode: 'replace',
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update provider')
    } finally {
      setSaving(false)
    }
  }

  const modelPlaceholder = modelHint ?? 'Use default model'
  const labelClassName = compact ? 'block text-sm font-medium text-secondary' : 'text-sm text-secondary'
  const inputClassName = compact
    ? 'setup-input min-h-11 w-full'
    : 'mt-0.5 w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none'

  const optionalFields = (
    <>
      <div className={compact ? 'space-y-1.5' : undefined}>
        <label className={labelClassName} htmlFor={`model-${providerName}`}>Model (optional)</label>
        <input
          id={`model-${providerName}`}
          type="text"
          className={inputClassName}
          placeholder={modelPlaceholder}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>
      <div>
        <label className={labelClassName}>Quota (optional)</label>
        <div className="mt-0.5 grid grid-cols-3 gap-1.5">
          <div>
            <input
              type="number"
              min="1"
              className={compact ? 'setup-input min-h-11 w-full' : 'w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none'}
              placeholder="Concurrent"
              value={maxConcurrency}
              onChange={(e) => setMaxConcurrency(e.target.value)}
            />
            <p className="mt-1 text-sm text-secondary">Max concurrent</p>
          </div>
          <div>
            <input
              type="number"
              min="1"
              className={compact ? 'setup-input min-h-11 w-full' : 'w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none'}
              placeholder="/min"
              value={maxPerMinute}
              onChange={(e) => setMaxPerMinute(e.target.value)}
            />
            <p className="mt-1 text-sm text-secondary">Per minute</p>
          </div>
          <div>
            <input
              type="number"
              min="1"
              className={compact ? 'setup-input min-h-11 w-full' : 'w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none'}
              placeholder="/day"
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(e.target.value)}
            />
            <p className="mt-1 text-sm text-secondary">Per day</p>
          </div>
        </div>
      </div>
    </>
  )

  const localEndpointField = isLocal ? (
    <div className={compact ? 'space-y-1.5' : undefined}>
      <label className={labelClassName} htmlFor={`base-url-${providerName}`}>Base URL</label>
      <input
        id={`base-url-${providerName}`}
        type="text"
        className={inputClassName}
        placeholder="http://localhost:11434/v1"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <p className="mt-1 text-sm text-secondary">Use any OpenAI-compatible endpoint, such as Ollama or vLLM.</p>
    </div>
  ) : null
  const apiKeyField = (
    <div className={compact ? 'min-w-0 space-y-1.5' : undefined}>
      <div className={compact ? 'flex items-center justify-between gap-3' : 'flex items-center justify-between'}>
        <label className={labelClassName} htmlFor={`api-key-${providerName}`}>
          API key{isLocal ? ' (optional)' : ''}
        </label>
        {keyUrl && !showGeminiFreeTier && (
          <a
            href={keyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-secondary hover:text-neutral underline underline-offset-2"
          >
            Get API key {'\u2197'}
          </a>
        )}
      </div>
      <input
        id={`api-key-${providerName}`}
        type="password"
        autoComplete="new-password"
        autoCapitalize="none"
        spellCheck={false}
        className={inputClassName}
        placeholder={isLocal ? 'Optional. Most local servers do not need one.' : `Enter ${providerName} API key`}
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
    </div>
  )
  const saveButton = (
    <Button type="button" size={compact ? 'default' : 'sm'} className={compact ? 'min-h-11' : undefined} disabled={!canSave || saving} onClick={asyncHandler(handleSave)}>
      {saving ? 'Saving...' : compact ? 'Save connection' : 'Save'}
    </Button>
  )

  return (
    <div className={compact ? 'space-y-3' : 'mt-3 rounded-lg border border-base bg-bg-elevated/40 p-3 space-y-2'}>
      {showGeminiFreeTier && (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3 pb-2">
          <div className="min-w-0 flex-1 basis-72 space-y-1">
            <h3 className="text-base font-semibold text-heading">Start with Gemini’s free tier</h3>
            <p className="max-w-prose text-sm text-secondary">
              Get a key in Google AI Studio, then paste it below. Free usage has model and rate limits; paid usage is billed by Google.{' '}
              <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noopener noreferrer" className="text-link underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2">
                Pricing and limits
              </a>
            </p>
          </div>
          <Button variant="outline" className="min-h-11" asChild>
            <a href={keyUrl} target="_blank" rel="noopener noreferrer">
              Get a free Gemini API key {'\u2197'}
            </a>
          </Button>
        </div>
      )}
      {compact ? (
        <>
          <div className={leadingField ? 'grid items-start gap-3 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]' : undefined}>
            {leadingField}
            {apiKeyField}
          </div>
          {localEndpointField}
        </>
      ) : <>{localEndpointField}{apiKeyField}</>}
      {compact ? (
        <details>
          <summary className="min-h-11 cursor-pointer text-sm text-secondary py-3">Advanced provider settings</summary>
          <div className="space-y-3 pt-2">{optionalFields}</div>
        </details>
      ) : optionalFields}
      {error && <p role="alert" className="text-sm text-negative-400">{error}</p>}
      {success && <p className="text-sm text-positive-400">Provider updated.</p>}
      {compact ? <div className="flex flex-wrap items-center gap-2">{saveButton}{secondaryActions}</div> : saveButton}
    </div>
  )
}
