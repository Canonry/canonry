import { useEffect, useState } from 'react'
import { ArrowLeft, Cloud, Globe } from 'lucide-react'

import { ApiError } from '../../api.js'
import {
  useConnectServerTrafficCloudRun,
  useConnectServerTrafficWordpress,
} from '../../queries/server-traffic.js'
import { Button } from '../ui/button.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet.js'

type SourceType = 'wordpress' | 'cloud-run'
type Step = 'pick' | SourceType

/**
 * Single entry point for connecting a server-traffic source. Step 1 picks the
 * source type; step 2 shows the matching connection form. Replaces the old
 * one-button-per-provider layout.
 */
export function ConnectSourceDrawer({
  open,
  onOpenChange,
  projectName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
}) {
  const [step, setStep] = useState<Step>('pick')

  // Always restart the wizard at the source picker when it reopens.
  useEffect(() => {
    if (open) setStep('pick')
  }, [open])

  // Every close path resets the step synchronously so a reopened drawer never
  // flashes the previously-selected form before the reopen effect above runs.
  const handleClose = () => {
    onOpenChange(false)
    setStep('pick')
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true)
        else handleClose()
      }}
    >
      <SheetContent>
        {step === 'pick' ? (
          <SourceTypePicker onPick={setStep} />
        ) : step === 'wordpress' ? (
          <WordpressSourceForm
            projectName={projectName}
            onBack={() => setStep('pick')}
            onClose={handleClose}
          />
        ) : (
          <CloudRunSourceForm
            projectName={projectName}
            onBack={() => setStep('pick')}
            onClose={handleClose}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

const SOURCE_TYPES: Array<{
  type: SourceType
  name: string
  tagline: string
  description: string
  icon: typeof Globe
}> = [
  {
    type: 'wordpress',
    name: 'WordPress site',
    tagline: 'Easiest if you run WordPress',
    description:
      'Install the Canonry Traffic Logger plugin and connect with an Application Password. No cloud account needed.',
    icon: Globe,
  },
  {
    type: 'cloud-run',
    name: 'Google Cloud Run',
    tagline: 'For apps hosted on Cloud Run',
    description:
      'Connect a Google Cloud service account so Canonry can read your Cloud Run request logs.',
    icon: Cloud,
  },
]

function SourceTypePicker({ onPick }: { onPick: (type: SourceType) => void }) {
  return (
    <>
      <SheetHeader>
        <SheetTitle>Connect a traffic source</SheetTitle>
        <SheetDescription>
          Canonry reads your server logs to see when AI crawlers and AI-referred visitors hit your
          site. Pick where your site is hosted to get started.
        </SheetDescription>
      </SheetHeader>

      <div className="mt-6 flex flex-col gap-3">
        {SOURCE_TYPES.map(({ type, name, tagline, description, icon: Icon }) => (
          <button
            key={type}
            type="button"
            onClick={() => onPick(type)}
            className="group flex items-start gap-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 text-left transition-colors hover:border-zinc-600 hover:bg-zinc-900/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
          >
            <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-300 group-hover:text-zinc-100">
              <Icon className="size-4" />
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium text-zinc-100">{name}</span>
                <span className="text-[11px] text-zinc-500">{tagline}</span>
              </span>
              <span className="text-xs leading-5 text-zinc-500">{description}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  )
}

function WizardHeader({
  title,
  description,
  onBack,
}: {
  title: string
  description: React.ReactNode
  onBack: () => void
}) {
  return (
    <SheetHeader>
      <button
        type="button"
        onClick={onBack}
        className="mb-1 inline-flex w-fit items-center gap-1 rounded text-xs text-zinc-500 transition-colors hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
      >
        <ArrowLeft className="size-3" />
        Choose a different source
      </button>
      <SheetTitle>{title}</SheetTitle>
      <SheetDescription>{description}</SheetDescription>
    </SheetHeader>
  )
}

function WordpressSourceForm({
  projectName,
  onBack,
  onClose,
}: {
  projectName: string
  onBack: () => void
  onClose: () => void
}) {
  const [baseUrl, setBaseUrl] = useState('')
  const [username, setUsername] = useState('')
  const [applicationPassword, setApplicationPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const connect = useConnectServerTrafficWordpress(projectName || null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    if (!baseUrl.trim()) {
      setError('WordPress site URL is required.')
      return
    }
    if (!username.trim()) {
      setError('Username is required.')
      return
    }
    if (!applicationPassword.trim()) {
      setError('Application Password is required.')
      return
    }
    try {
      const result = await connect.mutateAsync({
        baseUrl: baseUrl.trim(),
        username: username.trim(),
        applicationPassword: applicationPassword.trim(),
        displayName: displayName.trim() || undefined,
      })
      setApplicationPassword('')
      setSuccess(`Connected ${result.displayName}.`)
    } catch (e) {
      const message = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
      setError(message)
    }
  }

  return (
    <>
      <WizardHeader
        title="Connect a WordPress site"
        description={
          <>
            Pulls request events from the Canonry Traffic Logger plugin. The Application Password is
            stored in <code>~/.canonry/config.yaml</code> on the server and never echoed back to the
            dashboard.
          </>
        }
        onBack={onBack}
      />

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-5 overflow-y-auto pr-1">
        <Field label="Project" description="Canonry project this source attaches to.">
          <input
            type="text"
            value={projectName}
            disabled
            className="w-full rounded border border-zinc-700 bg-zinc-900/50 px-2 py-1.5 text-sm text-zinc-300"
          />
        </Field>

        <Field
          label="WordPress site URL"
          description="Base URL of the site running the Canonry Traffic Logger plugin."
          required
        >
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            required
            autoComplete="url"
            placeholder="https://example.com"
            className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
          />
        </Field>

        <Field
          label="Username"
          description="WordPress user that owns the Application Password."
          required
        >
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
            className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
          />
        </Field>

        <Field
          label="Application Password"
          description="Create one in wp-admin under Users -> Profile -> Application Passwords."
          required
        >
          <input
            type="password"
            value={applicationPassword}
            onChange={(e) => setApplicationPassword(e.target.value)}
            required
            autoComplete="new-password"
            className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
          />
        </Field>

        <Field
          label="Display name (optional)"
          description="Friendly label shown in the dashboard. Defaults to the WordPress host."
        >
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="off"
            className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
          />
        </Field>

        {error ? (
          <p className="rounded-md border border-rose-800/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className="rounded-md border border-emerald-800/50 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
            {success}
          </p>
        ) : null}

        <div className="mt-2 flex items-center justify-end gap-2 border-t border-zinc-800/60 pt-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" disabled={connect.isPending} size="sm">
            {connect.isPending ? 'Connecting...' : 'Connect'}
          </Button>
        </div>
      </form>
    </>
  )
}

function CloudRunSourceForm({
  projectName,
  onBack,
  onClose,
}: {
  projectName: string
  onBack: () => void
  onClose: () => void
}) {
  const [gcpProjectId, setGcpProjectId] = useState('')
  const [serviceName, setServiceName] = useState('')
  const [location, setLocation] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [keyJson, setKeyJson] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const connect = useConnectServerTrafficCloudRun(projectName || null)

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
    <>
      <WizardHeader
        title="Connect a Cloud Run service"
        description={
          <>
            v1 supports service-account JSON only. The private key is stored in{' '}
            <code>~/.canonry/config.yaml</code> on the server and never echoed back to the
            dashboard.
          </>
        }
        onBack={onBack}
      />

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-5 overflow-y-auto pr-1">
        <Field label="Project" description="Canonry project this source attaches to.">
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
          <p className="rounded-md border border-rose-800/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className="rounded-md border border-emerald-800/50 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
            {success}
          </p>
        ) : null}

        <div className="mt-2 flex items-center justify-end gap-2 border-t border-zinc-800/60 pt-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" disabled={connect.isPending} size="sm">
            {connect.isPending ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      </form>
    </>
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
