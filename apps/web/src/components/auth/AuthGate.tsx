import { type FormEvent, useEffect, useRef, useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { ApiError, fetchSession, hasExplicitBrowserApiKey, loginWithPassword, setupDashboardPassword, setOnAuthExpired } from '../../api.js'
import { createQueryClient } from '../../queries/query-client.js'
import { createAppRouter } from '../../router/router.js'
import { Button } from '../ui/button.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js'

const SESSION_RECHECK_MS = 60_000

export function AuthGate() {
  const [authState, setAuthState] = useState<'checking' | 'ready' | 'setup' | 'login'>(
    hasExplicitBrowserApiKey() ? 'ready' : 'checking',
  )
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)

  // Lazy-initialize router + query client only when needed for rendering
  const routerRef = useRef<ReturnType<typeof createAppRouter> | null>(null)
  const queryClientRef = useRef<ReturnType<typeof createQueryClient> | null>(null)
  const getRouter = () => {
    if (!routerRef.current) {
      const qc = createQueryClient()
      queryClientRef.current = qc
      routerRef.current = createAppRouter(qc)
    }
    return { queryClient: queryClientRef.current!, router: routerRef.current! }
  }

  // Initial session check
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

  // Periodic session re-check + auth expiry callback while authenticated.
  // Skipped in explicit-API-key mode — those users have no login form to fall
  // back to, so kicking them out of the dashboard would strand them.
  useEffect(() => {
    if (authState !== 'ready') return
    if (hasExplicitBrowserApiKey()) return

    // Periodic re-check. Only kick on a confirmed `authenticated: false`
    // response — transient network errors should not silently log the user
    // out. A real session loss will surface through the apiFetch 401/403
    // interceptor below the next time any request fires.
    const interval = setInterval(() => {
      fetchSession()
        .then((session) => {
          if (!session.authenticated) {
            setSessionExpired(true)
            setAuthState(session.setupRequired ? 'setup' : 'login')
          }
        })
        .catch(() => {
          // Network error or transient failure — leave the user on the
          // dashboard; the next real API call will catch a 401/403.
        })
    }, SESSION_RECHECK_MS)

    // Immediate auth expiry handler (triggered by apiFetch on 401/403)
    setOnAuthExpired(() => {
      setSessionExpired(true)
      setAuthState('login')
    })

    return () => {
      clearInterval(interval)
      setOnAuthExpired(null)
    }
  }, [authState])

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
      setSessionExpired(false)
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
      setSessionExpired(false)
      setAuthState('ready')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Authentication failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (authState === 'ready') {
    const { queryClient, router } = getRouter()
    return (
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
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
                {sessionExpired ? (
                  <p className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                    Your session expired — please sign in again.
                  </p>
                ) : null}
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
