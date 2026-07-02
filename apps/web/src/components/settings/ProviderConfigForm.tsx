import { useState } from 'react'

import { Button } from '../ui/button.js'
import { updateProviderConfig } from '../../api.js'
import { addToast } from '../../lib/toast-store.js'
import { asyncHandler } from '../../lib/async-handler.js'

export function ProviderConfigForm({ providerName, keyUrl, modelHint, onSaved }: {
  providerName: string
  keyUrl?: string
  modelHint?: string
  onSaved: () => void
}) {
  const isLocal = providerName.toLowerCase() === 'local'
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

  return (
    <div className="mt-3 rounded-lg border border-base bg-bg-elevated/40 p-3 space-y-2">
      {isLocal && (
        <div>
          <label className="text-xs text-muted" htmlFor={`base-url-${providerName}`}>Base URL</label>
          <input
            id={`base-url-${providerName}`}
            type="text"
            className="mt-0.5 w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
            placeholder="http://localhost:11434/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <p className="mt-0.5 text-[10px] text-faint">Any OpenAI-compatible endpoint — Ollama, LM Studio, llama.cpp, vLLM</p>
        </div>
      )}
      <div>
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted" htmlFor={`api-key-${providerName}`}>
            API Key{isLocal ? ' (optional)' : ''}
          </label>
          {keyUrl && (
            <a
              href={keyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-muted hover:text-neutral underline underline-offset-2"
            >
              Get API key {'\u2197'}
            </a>
          )}
        </div>
        <input
          id={`api-key-${providerName}`}
          type="password"
          className="mt-0.5 w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
          placeholder={isLocal ? 'Optional \u2014 most local servers don\'t need one' : `Enter ${providerName} API key`}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
      <div>
        <label className="text-xs text-muted" htmlFor={`model-${providerName}`}>Model (optional)</label>
        <input
          id={`model-${providerName}`}
          type="text"
          className="mt-0.5 w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
          placeholder={modelPlaceholder}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>
      <div>
        <label className="text-xs text-muted">Quota (optional)</label>
        <div className="mt-0.5 grid grid-cols-3 gap-1.5">
          <div>
            <input
              type="number"
              min="1"
              className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              placeholder="Concurrent"
              value={maxConcurrency}
              onChange={(e) => setMaxConcurrency(e.target.value)}
            />
            <p className="mt-0.5 text-[10px] text-faint">Max concurrent</p>
          </div>
          <div>
            <input
              type="number"
              min="1"
              className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              placeholder="/min"
              value={maxPerMinute}
              onChange={(e) => setMaxPerMinute(e.target.value)}
            />
            <p className="mt-0.5 text-[10px] text-faint">Per minute</p>
          </div>
          <div>
            <input
              type="number"
              min="1"
              className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              placeholder="/day"
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(e.target.value)}
            />
            <p className="mt-0.5 text-[10px] text-faint">Per day</p>
          </div>
        </div>
      </div>
      {error && <p className="text-xs text-negative-400">{error}</p>}
      {success && <p className="text-xs text-positive-400">Provider updated.</p>}
      <Button type="button" size="sm" disabled={!canSave || saving} onClick={asyncHandler(handleSave)}>
        {saving ? 'Saving...' : 'Save'}
      </Button>
    </div>
  )
}
