import { StrictMode, type FormEvent, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { ApiError, fetchSession, hasExplicitBrowserApiKey, loginWithPassword, setupDashboardPassword } from './api.js'
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
  const [authState, setAuthState] = useState<'checking' | 'ready' | 'setup' | 'login'>(
    hasExplicitBrowserApiKey() ? 'ready' : 'checking',
  )
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (hasExplicitBrowserApiKey()) return

    let cancelled = false
    void fetchSession()
      .then((session) => {
        if (cancelled) return
        if (session.authenticated) {
          setAuthState('ready')
        } else {
          setAuthState(session.setupRequired ? 'setup' : 'login')
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to reach the Canonry API')
        setAuthState('login')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const handleSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!password.trim() || password.trim().length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const session = await setupDashboardPassword(password.trim())
      if (!session.authenticated) {
        setError('Setup failed')
        return
      }
      setPassword('')
      setConfirmPassword('')
      setAuthState('ready')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Setup failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!password.trim()) return

    setSubmitting(true)
    setError(null)
    try {
      const session = await loginWithPassword(password.trim())
      if (!session.authenticated) {
        setError('Incorrect password')
        return
      }
      setPassword('')
      setAuthState('ready')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Authentication failed')
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
          {authState === 'checking' ? (
            <CardContent className="py-8">
              <p className="supporting-copy text-center">Connecting to Canonry…</p>
            </CardContent>
          ) : authState === 'setup' ? (
            <>
              <CardHeader>
                <p className="eyebrow eyebrow-soft">First-time setup</p>
                <CardTitle>Create a dashboard password</CardTitle>
                <CardDescription>
                  Choose a password to protect the Canonry dashboard. You will use this to sign in on future visits.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={handleSetup}>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-zinc-400">Password</span>
                    <input
                      autoFocus
                      className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-zinc-600"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="At least 8 characters"
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-zinc-400">Confirm password</span>
                    <input
                      className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-zinc-600"
                      type="password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      placeholder="Re-enter password"
                    />
                  </label>
                  {error ? <p className="text-sm text-rose-400">{error}</p> : null}
                  <Button type="submit" disabled={submitting || !password.trim() || !confirmPassword.trim()}>
                    {submitting ? 'Setting up…' : 'Create password & open dashboard'}
                  </Button>
                </form>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader>
                <p className="eyebrow eyebrow-soft">Dashboard access</p>
                <CardTitle>Sign in to Canonry</CardTitle>
                <CardDescription>
                  Enter your dashboard password to continue.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={handleLogin}>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-zinc-400">Password</span>
                    <input
                      autoFocus
                      className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-zinc-600"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="Dashboard password"
                    />
                  </label>
                  {error ? <p className="text-sm text-rose-400">{error}</p> : null}
                  <Button type="submit" disabled={submitting || !password.trim()}>
                    {submitting ? 'Signing in…' : 'Open dashboard'}
                  </Button>
                </form>
              </CardContent>
            </>
          )}
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
