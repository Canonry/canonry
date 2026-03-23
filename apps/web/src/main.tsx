import { StrictMode, type FormEvent, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { ApiError, fetchSession, hasExplicitBrowserApiKey, loginWithApiKey } from './api.js'
import { createQueryClient } from './queries/query-client.js'
import { createAppRouter } from './router/router.js'
import { Button } from './components/ui/button.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card.js'
import { Toaster } from './components/layout/Toaster.js'
import './styles.css'

const queryClient = createQueryClient()
const router = createAppRouter(queryClient)

const root = document.getElementById('root')

if (!root) {
  throw new Error('Expected #root element for web app bootstrap.')
}

function AuthGate() {
  const [authState, setAuthState] = useState<'checking' | 'ready' | 'unauthenticated'>(
    hasExplicitBrowserApiKey() ? 'ready' : 'checking',
  )
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (hasExplicitBrowserApiKey()) return

    let cancelled = false
    void fetchSession()
      .then((session) => {
        if (cancelled) return
        setAuthState(session.authenticated ? 'ready' : 'unauthenticated')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to reach the Canonry API')
        setAuthState('unauthenticated')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!apiKey.trim()) return

    setSubmitting(true)
    setError(null)
    try {
      const session = await loginWithApiKey(apiKey.trim())
      if (!session.authenticated) {
        setError('Authentication failed')
        setAuthState('unauthenticated')
        return
      }
      setApiKey('')
      setAuthState('ready')
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError('Authentication failed')
      }
      setAuthState('unauthenticated')
    } finally {
      setSubmitting(false)
    }
  }

  if (authState === 'ready') {
    return (
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster />
      </QueryClientProvider>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-950 px-4 py-8">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md items-center justify-center">
        <Card className="surface-card w-full">
          <CardHeader>
            <p className="eyebrow eyebrow-soft">Local access</p>
            <CardTitle>Authenticate with an API key</CardTitle>
            <CardDescription>
              The dashboard no longer receives the root API key automatically. Enter a valid Canonry API key to open a local session.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {authState === 'checking' ? (
              <p className="supporting-copy">Checking for an existing local session…</p>
            ) : (
              <form className="space-y-4" onSubmit={handleSubmit}>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-zinc-400">API key</span>
                  <input
                    autoFocus
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-zinc-600"
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="cnry_..."
                  />
                </label>
                {error ? <p className="text-sm text-rose-400">{error}</p> : null}
                <Button type="submit" disabled={submitting || !apiKey.trim()}>
                  {submitting ? 'Signing in…' : 'Open dashboard'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

createRoot(root).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
)
