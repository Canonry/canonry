import { useEffect, useState } from 'react'
import { ArrowLeft, Cloud, Globe, Triangle } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'

import { triggerServerTrafficBackfill } from '../../api.js'
import {
  useConnectServerTrafficCloudRun,
  useConnectServerTrafficVercel,
  useConnectServerTrafficWordpress,
} from '../../queries/server-traffic.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { extractErrorMessage } from '../../lib/extract-error-message.js'
import { Button } from '../ui/button.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet.js'

type SourceType = 'wordpress' | 'cloud-run' | 'vercel'
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
        ) : step === 'vercel' ? (
          <VercelSourceForm
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
  {
    type: 'vercel',
    name: 'Vercel project',
    tagline: 'For sites hosted on Vercel',
    description:
      'Connect a Vercel personal access token so Canonry can pull request logs straight from Vercel, no in-app instrumentation needed.',
    icon: Triangle,
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

/**
 * After a source connects, hand off to its detail page: kick off a backfill
 * so the source has historical data without a manual sync, then close the
 * drawer and route to the source detail page where the run is visible.
 * Backfill, not an incremental sync, is the first-load primitive: a sync's
 * default window can overrun an adapter's per-sync page budget.
 *
 * Rejects if the backfill kickoff fails. A failed kickoff creates no run
 * row, so the caller keeps the drawer open and shows the error instead of
 * routing to a detail page with nothing on it. `afterBackfillStarted` runs
 * only once the kickoff has succeeded.
 */
function useConnectedSourceHandoff(projectName: string, onClose: () => void) {
  const navigate = useNavigate()
  return async (sourceId: string, afterBackfillStarted?: () => void) => {
    await triggerServerTrafficBackfill(projectName, sourceId)
    afterBackfillStarted?.()
    onClose()
    void navigate({
      to: '/traffic/$projectName/$sourceId',
      params: { projectName, sourceId },
    })
  }
}

/**
 * Connect-form flow shared by every source type: holds the form error,
 * gates on form-specific validation, fires the connect mutation, and hands
 * off to the new source's detail page. Each form supplies only the
 * type-specific steps.
 */
function useConnectFlow(projectName: string, onClose: () => void) {
  const [error, setError] = useState<string | null>(null)
  const handoff = useConnectedSourceHandoff(projectName, onClose)

  const runConnect = async (steps: {
    /** Return a message when the form is invalid, or null when it is ready. */
    validate: () => string | null
    /** Fire the typed connect mutation and resolve with the created source. */
    mutate: () => Promise<{ id: string }>
    /** Runs once connect and the backfill kickoff both succeed, e.g. to clear the secret field. */
    onConnected?: () => void
  }) => {
    setError(null)
    const validationMessage = steps.validate()
    if (validationMessage) {
      setError(validationMessage)
      return
    }

    let source: { id: string }
    try {
      source = await steps.mutate()
    } catch (e) {
      setError(extractErrorMessage(e))
      return
    }

    // The source row exists now. Kick off the backfill and route to its
    // detail page. A backfill kickoff failure (bad credentials, 5xx,
    // network) creates no run row, so keep the drawer open and surface the
    // error rather than routing to a detail page with nothing to show.
    try {
      await handoff(source.id, steps.onConnected)
    } catch (e) {
      setError(`Source connected, but starting the initial backfill failed: ${extractErrorMessage(e)}`)
    }
  }

  return { error, runConnect }
}

/**
 * Shared chrome for every connect form: the wizard header, the scrolling form
 * body with the read-only project field, the validation-error banner, and the
 * Close / Connect footer. Each form supplies its header copy and its
 * type-specific fields as children.
 */
function ConnectSourceFormShell({
  title,
  description,
  projectName,
  onBack,
  onClose,
  onSubmit,
  isPending,
  error,
  children,
}: {
  title: string
  description: React.ReactNode
  projectName: string
  onBack: () => void
  onClose: () => void
  onSubmit: () => Promise<void>
  isPending: boolean
  error: string | null
  children: React.ReactNode
}) {
  return (
    <>
      <WizardHeader title={title} description={description} onBack={onBack} />

      <form
        onSubmit={asyncHandler(async (e: React.FormEvent) => {
          e.preventDefault()
          await onSubmit()
        })}
        className="mt-6 flex flex-col gap-5 overflow-y-auto pr-1"
      >
        <Field label="Project" description="Canonry project this source attaches to.">
          <input
            type="text"
            value={projectName}
            disabled
            className="w-full rounded border border-zinc-700 bg-zinc-900/50 px-2 py-1.5 text-sm text-zinc-300"
          />
        </Field>

        {children}

        {error ? (
          <p className="rounded-md border border-rose-800/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
            {error}
          </p>
        ) : null}

        <div className="mt-2 flex items-center justify-end gap-2 border-t border-zinc-800/60 pt-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" disabled={isPending} size="sm">
            {isPending ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      </form>
    </>
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

  const connect = useConnectServerTrafficWordpress(projectName || null)
  const { error, runConnect } = useConnectFlow(projectName, onClose)

  const handleSubmit = () =>
    runConnect({
      validate: () => {
        if (!baseUrl.trim()) return 'WordPress site URL is required.'
        if (!username.trim()) return 'Username is required.'
        if (!applicationPassword.trim()) return 'Application Password is required.'
        return null
      },
      mutate: () =>
        connect.mutateAsync({
          baseUrl: baseUrl.trim(),
          username: username.trim(),
          applicationPassword: applicationPassword.trim(),
          displayName: displayName.trim() || undefined,
        }),
      // Don't keep the Application Password around in memory after submit.
      onConnected: () => setApplicationPassword(''),
    })

  return (
    <ConnectSourceFormShell
      title="Connect a WordPress site"
      description={
        <>
          Pulls request events from the Canonry Traffic Logger plugin. The Application Password is
          stored in <code>~/.canonry/config.yaml</code> on the server and never echoed back to the
          dashboard.
        </>
      }
      projectName={projectName}
      onBack={onBack}
      onClose={onClose}
      onSubmit={handleSubmit}
      isPending={connect.isPending}
      error={error}
    >
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
    </ConnectSourceFormShell>
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

  const connect = useConnectServerTrafficCloudRun(projectName || null)
  const { error, runConnect } = useConnectFlow(projectName, onClose)

  const handleSubmit = () =>
    runConnect({
      validate: () => {
        if (!gcpProjectId.trim()) return 'GCP project ID is required.'
        if (!keyJson.trim()) return 'Service-account JSON content is required.'
        return null
      },
      mutate: () =>
        connect.mutateAsync({
          gcpProjectId: gcpProjectId.trim(),
          serviceName: serviceName.trim() || undefined,
          location: location.trim() || undefined,
          displayName: displayName.trim() || undefined,
          keyJson: keyJson.trim(),
        }),
      // Don't keep the private-key payload around in memory after submit.
      onConnected: () => setKeyJson(''),
    })

  const handleFile = async (file: File | null) => {
    if (!file) return
    const text = await file.text()
    setKeyJson(text)
  }

  return (
    <ConnectSourceFormShell
      title="Connect a Cloud Run service"
      description={
        <>
          v1 supports service-account JSON only. The private key is stored in{' '}
          <code>~/.canonry/config.yaml</code> on the server and never echoed back to the
          dashboard.
        </>
      }
      projectName={projectName}
      onBack={onBack}
      onClose={onClose}
      onSubmit={handleSubmit}
      isPending={connect.isPending}
      error={error}
    >
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
    </ConnectSourceFormShell>
  )
}

function VercelSourceForm({
  projectName,
  onBack,
  onClose,
}: {
  projectName: string
  onBack: () => void
  onClose: () => void
}) {
  const [projectId, setProjectId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [token, setToken] = useState('')
  const [environment, setEnvironment] = useState<'production' | 'preview'>('production')
  const [displayName, setDisplayName] = useState('')

  const connect = useConnectServerTrafficVercel(projectName || null)
  const { error, runConnect } = useConnectFlow(projectName, onClose)

  const handleSubmit = () =>
    runConnect({
      validate: () => {
        if (!projectId.trim()) return 'Vercel project ID is required.'
        if (!teamId.trim()) return 'Vercel team / account ID is required.'
        if (!token.trim()) return 'Vercel personal access token is required.'
        return null
      },
      mutate: () =>
        connect.mutateAsync({
          projectId: projectId.trim(),
          teamId: teamId.trim(),
          token: token.trim(),
          environment,
          displayName: displayName.trim() || undefined,
        }),
      // Don't keep the token around in memory after submit.
      onConnected: () => setToken(''),
    })

  return (
    <ConnectSourceFormShell
      title="Connect a Vercel project"
      description={
        <>
          Pulls request logs straight from Vercel, no in-app instrumentation needed. The personal
          access token is stored in <code>~/.canonry/config.yaml</code> on the server and never
          echoed back to the dashboard.
        </>
      }
      projectName={projectName}
      onBack={onBack}
      onClose={onClose}
      onSubmit={handleSubmit}
      isPending={connect.isPending}
      error={error}
    >
      <Field
        label="Vercel project ID"
        description="The prj_… id from the Vercel dashboard or .vercel/project.json."
        required
      >
        <input
          type="text"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          required
          autoComplete="off"
          placeholder="prj_…"
          className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
      </Field>

      <Field
        label="Vercel team / account ID"
        description="The Vercel team or personal account that owns the project. Find it as orgId in your .vercel/project.json."
        required
      >
        <input
          type="text"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          required
          autoComplete="off"
          className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
      </Field>

      <Field
        label="Personal access token"
        description="Create a Vercel personal access token under Account Settings → Tokens. Tokens can expire, so use a long-lived one."
        required
      >
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          autoComplete="new-password"
          className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
      </Field>

      <Field
        label="Environment"
        description="Which deployment environment's request logs to pull."
      >
        <select
          value={environment}
          onChange={(e) => setEnvironment(e.target.value as 'production' | 'preview')}
          className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none"
        >
          <option value="production">production</option>
          <option value="preview">preview</option>
        </select>
      </Field>

      <Field
        label="Display name (optional)"
        description="Friendly label shown in the dashboard. Defaults to the Vercel project ID."
      >
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoComplete="off"
          className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
      </Field>
    </ConnectSourceFormShell>
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
