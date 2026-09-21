import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, Bot, Check, Cloud, Copy, ExternalLink, Globe, Shield, Triangle } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'

import { triggerServerTrafficBackfill } from '../../api.js'
import {
  useConnectServerTrafficCloudRun,
  useConnectServerTrafficVercel,
  useConnectServerTrafficWordpress,
} from '../../queries/server-traffic.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { extractErrorMessage } from '../../lib/extract-error-message.js'
import { addToast } from '../../lib/toast-store.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { Button } from '../ui/button.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet.js'

type SourceType = 'cloudflare' | 'wordpress' | 'cloud-run' | 'vercel'
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
        ) : step === 'cloudflare' ? (
          <CloudflareGuide projectName={projectName} onBack={() => setStep('pick')} onClose={handleClose} />
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
  /** What the operator needs in hand, so they can pick before they commit. */
  needs: string
  icon: typeof Globe
}> = [
  {
    type: 'cloudflare',
    name: 'Cloudflare',
    needs: 'A zone you manage. Set up from the terminal.',
    icon: Shield,
  },
  {
    type: 'wordpress',
    name: 'WordPress',
    needs: 'wp-admin access to install a plugin',
    icon: Globe,
  },
  {
    type: 'vercel',
    name: 'Vercel',
    needs: 'A Vercel access token',
    icon: Triangle,
  },
  {
    type: 'cloud-run',
    name: 'Google Cloud Run',
    needs: 'A service account that can read logs',
    icon: Cloud,
  },
]

function SourceTypePicker({ onPick }: { onPick: (type: SourceType) => void }) {
  return (
    <>
      <SheetHeader>
        <SheetTitle>Connect a traffic source</SheetTitle>
        <SheetDescription>
          Pick where your site runs. Canonry reads AI crawler visits and AI referrals from there.
        </SheetDescription>
      </SheetHeader>

      <div className="mt-6 flex flex-col gap-3">
        {SOURCE_TYPES.map(({ type, name, needs, icon: Icon }) => (
          <button
            key={type}
            type="button"
            onClick={() => onPick(type)}
            className="group flex items-center gap-3 rounded-md border border-base bg-bg-elevated/30 px-3 py-3 text-left transition-colors hover:border-mono-600 hover:bg-bg-elevated/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
          >
            <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-base bg-bg text-neutral group-hover:text-heading">
              <Icon className="size-4" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium text-heading">{name}</span>
              <span className="text-[13px] text-secondary">{needs}</span>
            </span>
          </button>
        ))}
      </div>

      <p className="mt-6 text-[13px] text-secondary">
        Your agent can set up any of these for you. Pick a source to copy instructions for it.
      </p>
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
        className="mb-1 inline-flex w-fit items-center gap-1 rounded text-sm text-secondary transition-colors hover:text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
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
 * After a source connects, hand off to its detail page. Adapters with a safe
 * initial history window can kick off a backfill before navigation; adapters
 * with retention-limited history capture forward traffic and leave history as
 * an explicit operator action.
 *
 * Rejects if a requested backfill kickoff fails. A failed kickoff creates no run
 * row, so the caller keeps the drawer open and shows the error instead of
 * routing to a detail page with nothing on it. `afterConnected` runs only
 * once the optional kickoff has succeeded.
 */
function useConnectedSourceHandoff(projectName: string, onClose: () => void) {
  const navigate = useNavigate()
  return async (
    sourceId: string,
    options: { startInitialBackfill: boolean; afterConnected?: () => void },
  ) => {
    if (options.startInitialBackfill) {
      await triggerServerTrafficBackfill(projectName, sourceId)
    }
    options.afterConnected?.()
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
    /** Whether this adapter can safely start an implicit history backfill. */
    startInitialBackfill?: boolean
    /** Runs once connect and any requested backfill kickoff succeed. */
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

    // The source row exists now. Start history only for adapters that can do
    // so safely, then route to its detail page. A requested backfill kickoff
    // failure creates no run row, so keep the drawer open and surface it.
    try {
      await handoff(source.id, {
        startInitialBackfill: steps.startInitialBackfill ?? true,
        afterConnected: steps.onConnected,
      })
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
  guide,
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
  /** Agent handoff and prerequisites, shown before any field. */
  guide: SourceGuide
  children: React.ReactNode
}) {
  return (
    <>
      <WizardHeader title={title} description={description} onBack={onBack} />

      {/* One scrolling body: the sheet clips overflow, and the guide plus the
          form is taller than a laptop screen. */}
      <div className="-mr-1 mt-6 min-h-0 flex-1 overflow-y-auto pr-1">
      <div className="flex flex-col gap-5">
        <AgentHandoff request={guide.agentRequest} docsUrl={guide.docsUrl} />
        <SetupSteps steps={guide.steps} />
      </div>

      <form
        onSubmit={asyncHandler(async (e: React.FormEvent) => {
          e.preventDefault()
          await onSubmit()
        })}
        className="mt-6 flex flex-col gap-5 border-t border-default pt-5"
      >
        <p className="text-sm font-medium text-heading">
          Then connect it to <span className="font-mono text-[13px]">{projectName}</span>
        </p>

        {children}

        {error ? (
          <p className="rounded-md border border-negative-800/50 bg-negative-950/30 px-3 py-2 text-xs text-negative-200">
            {error}
          </p>
        ) : null}

        <div className="mt-2 flex items-center justify-end gap-2 border-t border-default pt-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" disabled={isPending} size="sm">
            {isPending ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      </form>
      </div>
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
        <span className="inline-flex items-center gap-1.5">
          Reads AI crawler visits from the Canonry Traffic Logger plugin.
          <InfoTooltip text={`${storageNote('Application Password')} Pages served from a full-page cache never reach the plugin, so exclude AI crawlers from your cache. The docs list the user agents.`} />
        </span>
      }
      guide={wordpressGuide(projectName, baseUrl)}
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
          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
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
          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
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
          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
        />
      </Field>

      <OptionalFields>
      <Field
        label="Display name (optional)"
        description="Friendly label shown in the dashboard. Defaults to the WordPress host."
      >
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoComplete="off"
          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
        />
      </Field>
      </OptionalFields>
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
        <span className="inline-flex items-center gap-1.5">
          Reads AI crawler visits from your Cloud Run request logs.
          <InfoTooltip text={storageNote('service-account private key')} />
        </span>
      }
      guide={cloudRunGuide(projectName, gcpProjectId)}
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
          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
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
          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 font-mono text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
          placeholder='{"type":"service_account","project_id":"…","private_key":"…"}'
          required
        />
        <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-sm text-secondary hover:text-strong">
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
          />
          <span className="rounded-md border border-base px-2 py-1">Or upload a key file</span>
        </label>
      </Field>

      <OptionalFields>
      <Field
        label="Service name (optional)"
        description="Restrict log pulls to a specific Cloud Run service. Omit to pull all services in the project."
      >
        <input
          type="text"
          value={serviceName}
          onChange={(e) => setServiceName(e.target.value)}
          autoComplete="off"
          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
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
          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
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
          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
        />
      </Field>

      </OptionalFields>
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
      // New Vercel sources start at NOW so regular sync stays inside upstream
      // retention. Historical recovery is explicit and user-sized.
      startInitialBackfill: false,
      // Don't keep the token around in memory after submit.
      onConnected: () => setToken(''),
    })

  return (
    <ConnectSourceFormShell
      title="Connect a Vercel project"
      description={
        <span className="inline-flex items-center gap-1.5">
          Reads AI crawler visits from Vercel request logs. Nothing to install on your site.
          <InfoTooltip text={storageNote('access token')} />
        </span>
      }
      guide={vercelGuide(projectName)}
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
          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
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
          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
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
          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
        />
      </Field>

      <OptionalFields>
      <Field
        label="Environment"
        description="Which deployment environment's request logs to pull."
      >
        <select
          value={environment}
          onChange={(e) => setEnvironment(e.target.value as 'production' | 'preview')}
          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong focus:border-mono-500 focus:outline-none"
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
          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
        />
      </Field>
      </OptionalFields>
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
      <span className="text-sm font-medium text-strong">
        {label}
        {required ? <span className="ml-1 text-negative-400">*</span> : null}
      </span>
      {children}
      <span className="text-[13px] leading-5 text-secondary">{description}</span>
    </label>
  )
}

// ── Setup guides ────────────────────────────────────────────────────────────
//
// Each source needs something done OUTSIDE Canonry before its form can work
// (a plugin installed, a token minted, a role granted). The form alone never
// said so. A guide names those steps with direct links, and hands the whole job
// to an agent for operators who would rather not do it by hand.

const DOCS_BASE = 'https://github.com/Canonry/canonry/blob/main'
const TRAFFIC_DOCS = `${DOCS_BASE}/skills/canonry/references/server-side-traffic.md`
const CLOUDFLARE_DOCS = `${DOCS_BASE}/docs/cloudflare-traffic-setup.md`

/**
 * The plugin ships as a GitHub release of this repo. Pinned to the version in
 * `packages/wordpress-traffic-logger-plugin/plugin/canonry-traffic-logger.php`,
 * which a test keeps in step so the link never points at a missing asset.
 */
export const WORDPRESS_PLUGIN_VERSION = '1.1.1'
export const WORDPRESS_PLUGIN_ZIP_URL =
  `https://github.com/Canonry/canonry/releases/download/wp-traffic-logger-v${WORDPRESS_PLUGIN_VERSION}/canonry-traffic-logger-${WORDPRESS_PLUGIN_VERSION}.zip`

export interface SetupStep {
  title: string
  detail?: string
  link?: { label: string; href: string }
}

export interface SourceGuide {
  steps: SetupStep[]
  agentRequest: string
  docsUrl: string
}

function storageNote(secret: string): string {
  return `The ${secret} is stored in ~/.canonry/config.yaml on the Canonry server and never sent back to the dashboard.`
}

/** An agent request shares one safety rule: secrets never pass through the chat. */
const SECRET_RULE = 'Never ask me to paste a password, token, or key into this chat. When a command needs one, give me the exact command to run myself, or read it from a file I point you to.'

/** The WordPress admin pages for a site the operator has typed in, when it parses. */
function wordpressAdminUrl(baseUrl: string, path: string): string | null {
  try {
    const url = new URL(baseUrl.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return `${url.origin}/wp-admin/${path}`
  } catch {
    return null
  }
}

export function wordpressGuide(projectName: string, baseUrl: string): SourceGuide {
  const uploadUrl = wordpressAdminUrl(baseUrl, 'plugin-install.php?tab=upload')
  const profileUrl = wordpressAdminUrl(baseUrl, 'profile.php#application-passwords-section')
  return {
    docsUrl: `${TRAFFIC_DOCS}#connecting-a-wordpress-source`,
    steps: [
      {
        title: 'Download the Canonry Traffic Logger plugin',
        link: { label: `Download v${WORDPRESS_PLUGIN_VERSION} (.zip)`, href: WORDPRESS_PLUGIN_ZIP_URL },
      },
      {
        title: 'Upload and activate it in wp-admin',
        detail: 'Plugins → Add New → Upload Plugin, then Activate.',
        ...(uploadUrl ? { link: { label: 'Open the upload page', href: uploadUrl } } : {}),
      },
      {
        title: 'Create an Application Password',
        detail: 'Users → Profile → Application Passwords. Name it “Canonry” and copy the password it shows once.',
        ...(profileUrl ? { link: { label: 'Open your profile', href: profileUrl } } : {}),
      },
      {
        title: 'Using a page cache or CDN? Exclude AI crawlers from it',
        detail: 'Cached pages never reach the plugin, so crawler visits go uncounted.',
        link: { label: 'User agents to exclude', href: `${TRAFFIC_DOCS}#connecting-a-wordpress-source` },
      },
    ],
    agentRequest: `Help me connect my WordPress site to the Canonry project "${projectName}" for server-side traffic.

Follow the WordPress section of the Canonry docs: ${TRAFFIC_DOCS}#connecting-a-wordpress-source

1. Ask me for the site URL and a WordPress admin username.
2. Walk me through installing the Canonry Traffic Logger plugin: download ${WORDPRESS_PLUGIN_ZIP_URL}, then upload and activate it under Plugins → Add New → Upload Plugin. If you have shell or WP-CLI access to the site, you may install it yourself after I approve.
3. Have me create an Application Password under Users → Profile → Application Passwords.
4. Ask whether the site uses a page cache or CDN. If it does, tell me exactly which AI user agents to exclude from it, using the list in the docs.
5. Give me the exact command to connect: cnry traffic connect wordpress ${projectName} --url <site-url> --username <user> --app-password '<app-password>'
6. After it connects, run cnry traffic sources ${projectName} --format json and cnry doctor --project ${projectName} --check 'traffic.source.*' --format json, and tell me in plain words whether events are arriving.

${SECRET_RULE}`,
  }
}

export function vercelGuide(projectName: string): SourceGuide {
  return {
    docsUrl: `${TRAFFIC_DOCS}#connecting-a-vercel-source`,
    steps: [
      {
        title: 'Create a Vercel access token',
        detail: 'Give it access to the team that owns the project. Tokens can expire, so pick a long lifetime.',
        link: { label: 'Open Vercel tokens', href: 'https://vercel.com/account/tokens' },
      },
      {
        title: 'Find the project ID and team ID',
        detail: 'Both are in the project’s Settings → General, or in .vercel/project.json (projectId and orgId) after vercel link.',
      },
    ],
    agentRequest: `Help me connect my Vercel project to the Canonry project "${projectName}" for server-side traffic.

Follow the Vercel section of the Canonry docs: ${TRAFFIC_DOCS}#connecting-a-vercel-source

1. Find the Vercel project ID and team ID. If this repo is linked, read projectId and orgId from .vercel/project.json. Otherwise ask me.
2. Have me create an access token at https://vercel.com/account/tokens, scoped to that team, and save it to a file only I can read.
3. Connect with: cnry traffic connect vercel ${projectName} --project-id <prj_...> --team-id <team_...> --token-file <path>
4. Confirm the source with cnry traffic sources ${projectName} --format json and cnry doctor --project ${projectName} --check 'traffic.source.*' --format json. Vercel keeps about 14 days of request logs, so tell me before starting any history backfill.

${SECRET_RULE}`,
  }
}

export function cloudRunGuide(projectName: string, gcpProjectId: string): SourceGuide {
  const project = gcpProjectId.trim()
  const serviceAccountsUrl = `https://console.cloud.google.com/iam-admin/serviceaccounts${project ? `?project=${encodeURIComponent(project)}` : ''}`
  return {
    docsUrl: `${TRAFFIC_DOCS}#connecting-a-cloud-run-source`,
    steps: [
      {
        title: 'Create a service account in the Google Cloud project',
        detail: 'Grant it the Logs Viewer role (roles/logging.viewer). Nothing broader is needed.',
        link: { label: 'Open service accounts', href: serviceAccountsUrl },
      },
      {
        title: 'Create a JSON key for it',
        detail: 'Keys → Add key → Create new key → JSON. Upload the file below.',
      },
    ],
    agentRequest: `Help me connect my Cloud Run service to the Canonry project "${projectName}" for server-side traffic.

Follow the Cloud Run section of the Canonry docs: ${TRAFFIC_DOCS}#connecting-a-cloud-run-source

1. Ask me for the Google Cloud project ID and, if there is more than one, the Cloud Run service name and region.
2. If gcloud is installed and signed in, propose the exact commands to create a service account with only roles/logging.viewer and download a JSON key, and run them after I approve. Otherwise walk me through it in the Cloud Console.
3. Connect with: cnry traffic connect cloud-run ${projectName} --gcp-project <project-id> --service-account-key <path/to/key.json> (add --service and --location to narrow it).
4. Confirm with cnry doctor --project ${projectName} --check 'traffic.source.*' --format json and tell me in plain words whether logs are readable.

${SECRET_RULE}`,
  }
}

export function cloudflareGuide(projectName: string): SourceGuide {
  return {
    docsUrl: CLOUDFLARE_DOCS,
    steps: [
      {
        title: 'Check your request volume first',
        detail: 'The Worker runs on every request to your zone. A busy site can pass the Workers free allowance of 100,000 requests a day.',
        link: { label: 'How to size it', href: `${CLOUDFLARE_DOCS}#before-you-start-size-the-request-volume` },
      },
      {
        title: 'Find your zone ID and account ID',
        detail: 'Both are on the zone’s Overview page in the Cloudflare dashboard, under API.',
        link: { label: 'Open Cloudflare', href: 'https://dash.cloudflare.com/' },
      },
      {
        title: 'Run the connect command where Canonry runs',
        detail: `cnry traffic connect cloudflare ${projectName} --zone-id <zone-id> --account-id <account-id>`,
      },
    ],
    agentRequest: `Help me connect my Cloudflare zone to the Canonry project "${projectName}" for server-side traffic.

Follow the Canonry Cloudflare guide: ${CLOUDFLARE_DOCS}

1. Before anything else, estimate the zone's daily request volume with me, as the guide's "size the request volume" section shows, and tell me whether it fits the Workers plan I am on.
2. Ask me for the zone ID and account ID, and whether I want direct push or Queue pull. Recommend one and say why.
3. Run cnry traffic connect cloudflare ${projectName} --zone-id <zone-id> --account-id <account-id> (plus the flags for the mode I chose). It writes the Worker and its config without deploying. Show me what it wrote.
4. Deploy only after I approve, and attach the route with Fail open exactly as the guide says.
5. Smoke-check with cnry traffic events ${projectName} --source <source-id> --format json and tell me whether events are arriving.

${SECRET_RULE}`,
  }
}

function AgentHandoff({ request, docsUrl }: { request: string; docsUrl: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      // `navigator.clipboard` is absent outside a secure context.
      await navigator.clipboard.writeText(request)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      addToast({
        tone: 'negative',
        title: 'Could not copy the setup request',
        detail: 'Follow the steps below, or open the setup guide instead.',
      })
    }
  }
  return (
    <section aria-labelledby="traffic-agent-heading" className="rounded-lg border border-default bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Bot className="size-4 text-positive" aria-hidden="true" />
        <h3 id="traffic-agent-heading" className="flex-1 text-sm font-medium text-heading">
          Have your agent set this up
        </h3>
        <Button type="button" variant="secondary" size="sm" onClick={() => { void copy() }}>
          {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
          <span aria-live="polite">{copied ? 'Copied' : 'Copy setup request'}</span>
        </Button>
      </div>
      <p className="mt-1.5 text-[13px] text-secondary">
        Paste it into Claude Code, Codex, or any agent with a terminal. It follows the{' '}
        <a href={docsUrl} target="_blank" rel="noreferrer" className="text-link underline-offset-4 hover:underline">
          setup guide
          <ExternalLink className="ml-0.5 inline size-3" aria-hidden="true" />
        </a>{' '}
        and never asks you to paste secrets into the chat.
      </p>
    </section>
  )
}

function SetupSteps({ steps, heading = 'Or do it yourself' }: { steps: SetupStep[]; heading?: string }) {
  return (
    <section aria-labelledby="traffic-steps-heading">
      <h3 id="traffic-steps-heading" className="text-sm font-medium text-heading">{heading}</h3>
      <ol className="mt-3 flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full border border-default bg-surface-subtle text-xs font-semibold tabular-nums text-secondary"
            >
              {index + 1}
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="text-sm text-heading">{step.title}</p>
              {step.detail ? (
                <p className={`mt-0.5 text-[13px] text-secondary ${step.detail.startsWith('cnry ') ? 'break-all font-mono' : ''}`}>
                  {step.detail}
                </p>
              ) : null}
              {step.link ? (
                <a
                  href={step.link.href}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-link underline-offset-4 hover:underline"
                >
                  {step.link.label}
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** Fields most operators never need, kept out of the way until asked for. */
function OptionalFields({ children }: { children: ReactNode }) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-sm font-medium text-secondary hover:text-heading">
        <span className="group-open:hidden">Show more options</span>
        <span className="hidden group-open:inline">Hide more options</span>
      </summary>
      <div className="mt-4 flex flex-col gap-5">{children}</div>
    </details>
  )
}

/**
 * Cloudflare deploys a Worker on the operator's zone, which only the local CLI
 * does (and deliberately never MCP), so this step is a guide, not a form.
 */
function CloudflareGuide({
  projectName,
  onBack,
  onClose,
}: {
  projectName: string
  onBack: () => void
  onClose: () => void
}) {
  const guide = cloudflareGuide(projectName)
  return (
    <>
      <WizardHeader
        title="Connect a Cloudflare zone"
        description={
          <span className="inline-flex items-center gap-1.5">
            A small Worker on your zone reports AI crawler visits. It is set up from the terminal.
            <InfoTooltip text="Setting it up deploys a Worker to your Cloudflare account, so it runs from the Canonry CLI on the machine where Canonry runs, never from the browser." />
          </span>
        }
        onBack={onBack}
      />
      <div className="-mr-1 mt-6 min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="flex flex-col gap-5">
          <AgentHandoff request={guide.agentRequest} docsUrl={guide.docsUrl} />
          <SetupSteps steps={guide.steps} />
        </div>
        <div className="mt-6 flex items-center justify-end gap-2 border-t border-default pt-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button type="button" size="sm" asChild>
            <a href={guide.docsUrl} target="_blank" rel="noreferrer">
              Open the setup guide
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </Button>
        </div>
      </div>
    </>
  )
}
