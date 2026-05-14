import { useState } from 'react'

import { ApiError } from '../../api.js'
import { useConnectServerTrafficWordpress } from '../../queries/server-traffic.js'
import { Button } from '../ui/button.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet.js'

export function ConnectWordpressDrawer({
  open,
  onOpenChange,
  projectName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
}) {
  const [baseUrl, setBaseUrl] = useState('')
  const [username, setUsername] = useState('')
  const [applicationPassword, setApplicationPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const connect = useConnectServerTrafficWordpress(projectName || null)

  const reset = () => {
    setBaseUrl('')
    setUsername('')
    setApplicationPassword('')
    setDisplayName('')
    setError(null)
    setSuccess(null)
  }

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
    <Sheet open={open} onOpenChange={(next) => {
      onOpenChange(next)
      if (!next) reset()
    }}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Connect WordPress traffic source</SheetTitle>
          <SheetDescription>
            Pulls request events from the Canonry Traffic Logger plugin. The Application Password is stored in <code>~/.canonry/config.yaml</code> on the server and never echoed back to the dashboard.
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
              {connect.isPending ? 'Connecting...' : 'Connect'}
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
