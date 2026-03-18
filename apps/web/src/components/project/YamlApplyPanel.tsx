import { useState } from 'react'
import { parseAllDocuments } from 'yaml'

import { Button } from '../ui/button.js'
import { applyProjectConfig } from '../../api.js'

export function YamlApplyPanel({ onApplied }: { onApplied: () => void }) {
  const [yamlText, setYamlText] = useState('')
  const [applying, setApplying] = useState(false)
  const [results, setResults] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])

  const handleApply = async () => {
    if (!yamlText.trim()) return
    setApplying(true)
    setResults([])
    setErrors([])

    const docs = parseAllDocuments(yamlText)
    const errs: string[] = []
    const applied: string[] = []

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]!
      if (doc.errors.length > 0) {
        errs.push(`Document ${i + 1}: ${doc.errors[0]?.message}`)
        continue
      }
      const config = doc.toJSON() as object
      if (!config || typeof config !== 'object') continue
      try {
        const result = await applyProjectConfig(config)
        applied.push(`Applied "${result.displayName || result.name}" (revision ${result.configRevision})`)
      } catch (err) {
        errs.push(`Document ${i + 1}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    setResults(applied)
    setErrors(errs)
    setApplying(false)
    if (applied.length > 0) onApplied()
  }

  return (
    <section className="mt-8">
      <div className="page-section-divider" />
      <div className="section-head mt-6">
        <div>
          <p className="eyebrow eyebrow-soft">Config as code</p>
          <h2 className="text-sm font-medium text-zinc-200">Apply YAML</h2>
        </div>
      </div>
      <p className="text-zinc-500 text-sm mb-3">Paste a <code className="text-zinc-400">canonry.yaml</code> config (multi-document YAML with <code className="text-zinc-400">---</code> separators supported).</p>
      <textarea
        className="setup-input w-full font-mono text-xs"
        rows={10}
        placeholder={'apiVersion: canonry/v1\nkind: Project\nmetadata:\n  name: my-project\nspec:\n  canonicalDomain: example.com\n  country: US\n  language: en\n  keywords: []'}
        value={yamlText}
        onChange={(e) => setYamlText(e.target.value)}
      />
      {results.length > 0 && (
        <ul className="mt-2 space-y-1">
          {results.map((r, i) => <li key={i} className="text-emerald-400 text-sm">{r}</li>)}
        </ul>
      )}
      {errors.length > 0 && (
        <ul className="mt-2 space-y-1">
          {errors.map((e, i) => <li key={i} className="text-rose-400 text-sm">{e}</li>)}
        </ul>
      )}
      <div className="mt-3">
        <Button type="button" disabled={!yamlText.trim() || applying} onClick={handleApply}>
          {applying ? 'Applying...' : 'Apply'}
        </Button>
      </div>
    </section>
  )
}
