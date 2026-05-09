import { useState } from 'react'

import { Button } from '../ui/button.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet.js'
import { ApiError } from '../../api.js'
import { useConnectServerTrafficCloudRun } from '../../queries/server-traffic.js'

export function ConnectCloudRunDrawer({
  open,
  onOpenChange,
  projectName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
}) {
  const [gcpProjectId, setGcpProjectId] = useState('')
  const [serviceName, setServiceName] = useState('')
  const [location, setLocation] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [keyJson, setKeyJson] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const connect = useConnectServerTrafficCloudRun(projectName || null)

  const reset = () => {
    setGcpProjectId('')
    setServiceName('')
    setLocation('')
    setDisplayName('')
    setKeyJson('')
    setError(null)
    setSuccess(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    if (!gcpProjectId.trim()) {
      setError('GCP project ID is required.')
      return
    }
    if (!keyJson.trim()) {
      setError('Service-account JSON content is required.')
      return
    }
    try {
      const result = await connect.mutateAsync({
        gcpProjectId: gcpProjectId.trim(),
        serviceName: serviceName.trim() || undefined,
        location: location.trim() || undefined,
        displayName: displayName.trim() || undefined,
        keyJson: keyJson.trim(),
      })
      // Don't keep the private-key payload around in memory after submit.
      setKeyJson('')
      setSuccess(`Connected ${result.displayName}.`)
    } catch (e) {
      const message = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
      setError(message)
    }
  }

  const handleFile = async (file: File | null) => {
    if (!file) return
    const text = await file.text()
    setKeyJson(text)
  }

  return (
    <Sheet open={open} onOpenChange={(next) => {
      onOpenChange(next)
      if (!next) reset()
    }}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Connect Cloud Run traffic source</SheetTitle>
          <SheetDescription>
            v1 supports service-account JSON only. The private key is stored in <code>~/.canonry/config.yaml</code> on the server and never echoed back to the dashboard.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-5 overflow-y-auto pr-1">
          <Field
            label="Project"
            description="Canonry project this source attaches to."
          >
            <input
              type="text"
              value={projectName}
              disabled
              className="w-full rounded border border-zinc-700 bg-zinc-900/50 px-2 py-1.5 text-sm text-zinc-300"
            />
          </Field>

          <Field
            label="GCP project ID"
            description="The Google Cloud project hosting the Cloud Run service (e.g. my-prod-foo)."
            required
          >
            <input
              type="text"
              value={gcpProjectId}
              onChange={(e) => setGcpProjectId(e.target.value)}
              required
              autoComplete="off"
              className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
          </Field>

          <Field
            label="Service name (optional)"
            description="Restrict log pulls to a specific Cloud Run service. Omit to pull all services in the project."
          >
            <input
              type="text"
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              autoComplete="off"
              className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
          </Field>

          <Field
            label="Location (optional)"
            description="Region of the Cloud Run service (e.g. us-central1). Helpful when multiple regions emit logs."
          >
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              autoComplete="off"
              className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
          </Field>

          <Field
            label="Display name (optional)"
            description="Friendly label shown in the dashboard. Defaults to the project + service combo."
          >
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="off"
              className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
          </Field>

          <Field
            label="Service-account JSON"
            description="Paste the contents of the SA key (JSON). The SA needs roles/logging.viewer (or any role granting logging.logEntries.list)."
            required
          >
            <textarea
              value={keyJson}
              onChange={(e) => setKeyJson(e.target.value)}
              rows={6}
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 font-mono text-[11px] text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              placeholder='{"type":"service_account","project_id":"…","private_key":"…"}'
              required
            />
            <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200">
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
              />
              <span className="rounded-md border border-zinc-800 px-2 py-1">Or upload a key file</span>
            </label>
          </Field>

          {error ? (
            <p className="rounded-md border border-rose-800/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{error}</p>
          ) : null}
          {success ? (
            <p className="rounded-md border border-emerald-800/50 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">{success}</p>
          ) : null}

          <div className="mt-2 flex items-center justify-end gap-2 border-t border-zinc-800/60 pt-4">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button type="submit" disabled={connect.isPending} size="sm">
              {connect.isPending ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function Field({
  label,
  description,
  required,
  children,
}: {
  label: string
  description: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-zinc-200">
        {label}
        {required ? <span className="ml-1 text-rose-400">*</span> : null}
      </span>
      {children}
      <span className="text-[11px] text-zinc-500">{description}</span>
    </label>
  )
}
