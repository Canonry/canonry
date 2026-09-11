import { type FormEvent, useEffect, useRef, useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import {
  USER_PASSWORD_MIN_LENGTH,
  userNameSchema,
  userPasswordSchema,
  type ApiKeyDto,
} from '@ainyc/canonry-contracts'

import {
  ApiError,
  clearDashboardSession,
  createFirstAdministrator,
  fetchAccountSession,
  fetchAuthProviders,
  fetchCurrentApiKey,
  fetchSession,
  hasExplicitBrowserApiKey,
  loginWithApiKey,
  isEmbed,
  loginWithPassword,
  reportForegroundActivity,
  setOnAuthExpired,
  signInWithAccount,
  signOutOfAccount,
  startGoogleSignIn,
  type ApiAccountSession,
} from '../../api.js'
import { AccountProvider, type SignedInAccount } from '../../contexts/account-context.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { createQueryClient } from '../../queries/query-client.js'
import { createAppRouter } from '../../router/router.js'
import { _BASE_PREFIX } from '../../lib/base-path.js'
import { Button } from '../ui/button.js'
import { Card, CardContent, CardDescription, CardHeader } from '../ui/card.js'
import { AUTH_COPY } from './auth-copy.js'

const SESSION_RECHECK_MS = 60_000

/**
 * `account-login` is the named-account sign-in. `setup` and `login` are the
 * older shared-password screens, which apply only to an install that has no
 * accounts at all — and which the server refuses once any account exists.
 */
type AuthState = 'checking' | 'ready' | 'setup' | 'login' | 'account-login' | 'api-key-error'
type SharedLoginMethod = 'password' | 'api-key'

/** Cache identity must move when an administrator changes a role or revokes auth. */
export function accountPrincipalCacheKey(account: SignedInAccount): string {
  return `${account.id ?? account.name}:${account.authVersion ?? 0}:${account.role}`
}

export function AuthGate() {
  const explicitBrowserApiKey = useRef(hasExplicitBrowserApiKey()).current
  const [authState, setAuthState] = useState<AuthState>(
    explicitBrowserApiKey ? 'ready' : 'checking',
  )
  const [account, setAccount] = useState<SignedInAccount | null>(null)
  const [apiKey, setApiKey] = useState<ApiKeyDto | null>(null)
  const [apiKeyPending, setApiKeyPending] = useState(explicitBrowserApiKey)
  const [accountsInUse, setAccountsInUse] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [setupKey, setSetupKey] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [useAccountPassword, setUseAccountPassword] = useState(false)
  const [sharedLoginMethod, setSharedLoginMethod] = useState<SharedLoginMethod>('password')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [googleEnabled, setGoogleEnabled] = useState<boolean | null>(null)
  const [invitationToken] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return new URLSearchParams(window.location.hash.slice(1)).get('invitation')
  })

  // Lazy-initialize router + query client only when needed for rendering.
  //
  // Both are rebuilt whenever the person changes. The cache holds whatever the
  // PREVIOUS account was allowed to read — an administrator's provider settings,
  // for instance — and a cache that outlives a sign-out hands that straight to
  // whoever signs in next on the same tab. Keying it to the principal makes the
  // cache's lifetime the session's lifetime.
  const routerRef = useRef<ReturnType<typeof createAppRouter> | null>(null)
  const queryClientRef = useRef<ReturnType<typeof createQueryClient> | null>(null)
  const cachedForPrincipalRef = useRef<string | null>(null)
  const getRouter = () => {
    // An injected browser key is ONE principal for the life of the page: it
    // cannot change without a reload. Keying it by id meant the key moved from
    // `api-key:pending` to `api-key:<id>` when `/keys/self` resolved, clearing
    // the cache and rebuilding the router a moment after first paint, which
    // discards in-flight queries and every piece of local component state.
    const principalKey = account
      ? accountPrincipalCacheKey(account)
      : explicitBrowserApiKey
        ? 'api-key:explicit'
        : apiKey
          ? `api-key:${apiKey.id}`
          : 'no-accounts'
    if (!routerRef.current || cachedForPrincipalRef.current !== principalKey) {
      queryClientRef.current?.clear()
      const qc = createQueryClient()
      queryClientRef.current = qc
      routerRef.current = createAppRouter(qc)
      cachedForPrincipalRef.current = principalKey
    }
    return { queryClient: queryClientRef.current!, router: routerRef.current! }
  }

  const applyAccountSession = (session: ApiAccountSession): boolean => {
    if (!session.authRequired) return false
    setAccountsInUse(true)
    setAccount(session.user)
    setApiKey(null)
    setApiKeyPending(false)
    setAuthState(session.user ? 'ready' : 'account-login')
    return true
  }

  // Initial session check.
  //
  // Both questions go out together rather than one after the other: asking the
  // account-aware one first and only then the older one would put a second
  // round trip in front of every page load, on an install where the answer to
  // the first is almost always "no accounts". The account answer WINS when it
  // says accounts are in use; otherwise the older shared-password answer
  // decides, exactly as it always did.
  useEffect(() => {
    let cancelled = false
    // What a FAILED hydration means depends on who asked, so the caller says.
    // `apiKeyPending` is deliberately NOT cleared on failure: with no key and no
    // account the provider falls through to NO_ACCOUNTS, which grants FULL
    // access, so clearing it would turn a fail-closed state into a fail-open
    // one. It stays pending and the new state makes that visible and retryable.
    const hydrateApiKey = async (onFailure: AuthState, clearInvalidSession = false) => {
      try {
        const key = await fetchCurrentApiKey()
        if (cancelled) return
        setApiKey(key)
        setApiKeyPending(false)
        setAuthState('ready')
      } catch (err) {
        if (cancelled) return

        // `/session` knows that the cookie is still present, but `/keys/self`
        // is authoritative about whether its bound key still exists and is
        // usable. End a stale shared session before returning to sign-in so a
        // reload cannot rediscover the same invalid cookie forever.
        if (clearInvalidSession && err instanceof ApiError && err.statusCode === 401) {
          return clearDashboardSession()
            .then(() => {
              if (cancelled) return
              setError(null)
              setApiKey(null)
              setApiKeyPending(false)
              setSessionExpired(true)
              setAuthState('login')
            })
            .catch((clearError: unknown) => {
              if (cancelled) return
              setError(clearError instanceof Error ? clearError.message : 'Could not clear the invalid session')
              setAuthState(onFailure)
            })
        }

        setError(err instanceof Error ? err.message : 'Could not verify API key access')
        setAuthState(onFailure)
      }
    }

    if (explicitBrowserApiKey) {
      void hydrateApiKey('api-key-error')
      return () => { cancelled = true }
    }

    void Promise.allSettled([fetchAccountSession(), fetchSession()])
      .then(([accountResult, legacyResult]) => {
        if (cancelled) return

        if (accountResult.status === 'fulfilled') {
          if (applyAccountSession(accountResult.value)) return

          // `authRequired: false` is authoritative: there are no named
          // accounts. Keep an already-unlocked legacy install unlocked, but
          // let a fresh Cloud install (which has no legacy session endpoint)
          // create its first administrator.
          if (legacyResult.status === 'rejected') {
            const err: unknown = legacyResult.reason
            if (err instanceof ApiError && err.statusCode === 404) {
              setAuthState('setup')
              return
            }
            setError(err instanceof Error ? err.message : 'Failed to reach the Canonry API')
            setAuthState('login')
            return
          }
        }

        if (legacyResult.status === 'rejected') {
          const err: unknown = legacyResult.reason
          setError(err instanceof Error ? err.message : 'Failed to reach the Canonry API')
          setAuthState('login')
          return
        }

        const session = legacyResult.value
        if (session.authenticated) {
          // A shared-password session may have been created with an API key,
          // including a read-only or project-scoped one. Keep the dashboard
          // locked until the exact key metadata resolves: falling through with
          // no key and no account grants the install's full-access default.
          setApiKeyPending(true)
          void hydrateApiKey('api-key-error', true)
        } else {
          setApiKey(null)
          setApiKeyPending(false)
          setAuthState(session.setupRequired ? 'setup' : 'login')
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Invitation tokens are intentionally one-hop only: retain them in component
  // memory for the Google redirect request, then remove the URL fragment before
  // any navigation, analytics, or copied address can expose it.
  useEffect(() => {
    if (!invitationToken || typeof window === 'undefined') return
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
  }, [invitationToken])

  useEffect(() => {
    if ((authState !== 'account-login' && !invitationToken) || explicitBrowserApiKey && !invitationToken) return
    let cancelled = false
    void fetchAuthProviders()
      .then((providers) => {
        if (!cancelled) setGoogleEnabled(providers.google.enabled && Boolean(providers.google.startUrl))
      })
      .catch(() => {
        // Password sign-in remains usable if a newly wired provider route is unavailable.
        if (!cancelled) setGoogleEnabled(false)
      })
    return () => { cancelled = true }
  }, [authState, explicitBrowserApiKey, invitationToken])

  useEffect(() => {
    if (!account || explicitBrowserApiKey || isEmbed() || typeof window === 'undefined') return
    let lastReportedAt = 0
    const report = () => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastReportedAt < 5 * 60_000) return
      lastReportedAt = now
      void reportForegroundActivity().catch(() => {
        // Presence is advisory. A transient miss must not interrupt work.
      })
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') report() }
    window.addEventListener('focus', report)
    window.addEventListener('pointerdown', report, { passive: true })
    window.addEventListener('keydown', report)
    window.addEventListener('popstate', report)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', report)
      window.removeEventListener('pointerdown', report)
      window.removeEventListener('keydown', report)
      window.removeEventListener('popstate', report)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [account, explicitBrowserApiKey])

  // Periodic session re-check + auth expiry callback while authenticated.
  // Skipped in explicit-API-key mode — those users have no login form to fall
  // back to, so kicking them out of the dashboard would strand them.
  useEffect(() => {
    if (authState !== 'ready') return
    if (explicitBrowserApiKey) return

    // Periodic re-check. Only kick on a confirmed signed-out response —
    // transient network errors should not silently log the user out. A real
    // session loss will surface through the apiFetch 401 interceptor below the
    // next time any request fires.
    const interval = setInterval(() => {
      if (accountsInUse) {
        fetchAccountSession()
          .then((session) => {
            if (session.authRequired && !session.user) {
              setSessionExpired(true)
              setAccount(null)
              setApiKey(null)
              setAuthState('account-login')
            } else if (session.authRequired && session.user) {
              // Role/auth-version changes invalidate the principal-keyed cache.
              setAccount(session.user)
            }
          })
          .catch(() => {
            // Leave the user where they are; the next real request will catch it.
          })
        return
      }
      fetchSession()
        .then((session) => {
          if (!session.authenticated) {
            setSessionExpired(true)
            setApiKey(null)
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
      setAccount(null)
      setApiKey(null)
      setApiKeyPending(false)
      setAuthState(accountsInUse ? 'account-login' : 'login')
    })

    return () => {
      clearInterval(interval)
      setOnAuthExpired(null)
    }
  }, [authState, accountsInUse, explicitBrowserApiKey])

  const handleSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsedName = userNameSchema.safeParse(name.trim())
    const parsedPassword = userPasswordSchema.safeParse(password)
    if (!parsedName.success) {
      setError(parsedName.error.issues[0]?.message ?? 'Enter a valid username.')
      return
    }
    if (!setupKey.trim()) return
    if (!parsedPassword.success) {
      setError(parsedPassword.error.issues[0]?.message ?? AUTH_COPY.shortPasswordHelp)
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await createFirstAdministrator({ name: parsedName.data, password: parsedPassword.data }, setupKey.trim())
      // A setup key authorizes exactly this one request. It never enters
      // storage and is discarded before the normal browser session begins.
      setSetupKey('')
      setPassword('')
      setConfirmPassword('')
      setShowPassword(false)
      try {
        const session = await signInWithAccount(parsedName.data, parsedPassword.data)
        if (!session.user) throw new Error('Sign-in did not establish an account session')
        if (typeof window !== 'undefined') {
          window.history.replaceState(window.history.state, '', `${_BASE_PREFIX}/settings?section=sign-in`)
        }
        setSessionExpired(false)
        setAccountsInUse(true)
        setAccount(session.user)
        setApiKey(null)
        setApiKeyPending(false)
        setAuthState('ready')
      } catch {
        // The account exists now. Never replay creation on a retry: return to
        // ordinary account sign-in instead.
        setAccountsInUse(true)
        setPassword('')
        setError(AUTH_COPY.administratorCreatedSignIn)
        setAuthState('account-login')
      }
    } catch (err) {
      // The insert may have committed even when its response was lost. Ask the
      // public session state before offering setup again; once named auth is
      // durable, this browser must never replay first-account creation.
      try {
        const session = await fetchAccountSession()
        if (session.authRequired) {
          setAccountsInUse(true)
          setSetupKey('')
          setPassword('')
          setConfirmPassword('')
          setError(AUTH_COPY.administratorSetupCompleteSignIn)
          setAuthState('account-login')
          return
        }
      } catch {
        // Preserve the original setup failure when the state check is also unavailable.
      }
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not create administrator account')
    } finally {
      setSubmitting(false)
    }
  }

  const updatePassword = (value: string) => {
    setPassword(value)
    setError(null)
  }

  const updateConfirmPassword = (value: string) => {
    setConfirmPassword(value)
    setError(null)
  }

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!password.trim()) return

    setSubmitting(true)
    setError(null)
    try {
      const session = sharedLoginMethod === 'api-key'
        ? await loginWithApiKey(password.trim())
        : await loginWithPassword(password.trim())
      if (!session.authenticated) {
        setError(sharedLoginMethod === 'api-key' ? 'Invalid API key' : 'Incorrect password')
        return
      }
      const currentApiKey = await fetchCurrentApiKey()
      setApiKey(currentApiKey)
      setApiKeyPending(false)
      setPassword('')
      setShowPassword(false)
      setSessionExpired(false)
      setAuthState('ready')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Authentication failed')
    } finally {
      setSubmitting(false)
    }
  }

  const changeSharedLoginMethod = (method: SharedLoginMethod) => {
    setSharedLoginMethod(method)
    setPassword('')
    setShowPassword(false)
    setError(null)
  }

  const handleAccountSignIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim() || !password) return

    setSubmitting(true)
    setError(null)
    try {
      const session = await signInWithAccount(name.trim(), password)
      if (!session.user) {
        setError(AUTH_COPY.incorrectAccountCredentials)
        return
      }
      setPassword('')
      setSessionExpired(false)
      setAccount(session.user)
      setApiKey(null)
      setApiKeyPending(false)
      setAuthState('ready')
    } catch (err) {
      // The server answers the same way for every failure, so whatever it says
      // is what the person is shown.
      setError(err instanceof ApiError ? err.message : AUTH_COPY.incorrectAccountCredentials)
    } finally {
      setSubmitting(false)
    }
  }

  const handleGoogleSignIn = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const { redirectUrl } = await startGoogleSignIn({
        invitationToken: invitationToken ?? undefined,
        returnTo: typeof window === 'undefined' ? undefined : `${window.location.pathname}${window.location.search}`,
      })
      window.location.assign(redirectUrl)
    } catch {
      setError(invitationToken
        ? AUTH_COPY.invitationUnavailable
        : 'Google sign-in could not be started. Try again or use a password.')
      setSubmitting(false)
    }
  }

  const handleInvitationSignOut = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await signOutOfAccount()
      setAccount(null)
      setApiKey(null)
      setApiKeyPending(false)
      setSessionExpired(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : AUTH_COPY.invitationUnavailable)
    } finally {
      setSubmitting(false)
    }
  }

  const googleCallbackError = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('authError')
    : null
  const invitationFailed = googleCallbackError === 'google-invitation-failed'

  if (authState === 'ready' && !invitationToken && !invitationFailed) {
    const { queryClient, router } = getRouter()
    return (
      <AccountProvider account={account} apiKey={apiKey} apiKeyPending={apiKeyPending}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AccountProvider>
    )
  }

  const setupNameResult = userNameSchema.safeParse(name.trim())
  const setupNameError = name.length > 0 && !setupNameResult.success
    ? setupNameResult.error.issues[0]?.message
    : undefined
  const setupPasswordResult = userPasswordSchema.safeParse(password)
  const setupPasswordIsShort = password.length > 0 && !setupPasswordResult.success
  const setupConfirmationMismatch = confirmPassword.length > 0 && password !== confirmPassword
  const setupFormIsValid = setupNameResult.success && Boolean(setupKey.trim())
    && setupPasswordResult.success && password === confirmPassword
  const invitationFlow = Boolean(invitationToken) && authState !== 'checking'

  return (
    <div className="min-h-screen bg-bg px-4 py-8">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md flex-col items-center justify-center gap-5">
        {/* The first screen a client ever sees, often before they know what
            the product is. Plain markup rather than <BrandLockup>, which is
            built on router <Link>s — this gate renders before the router. */}
        <div data-testid="auth-brand" className="flex items-center gap-2.5">
          <img className="size-7" src="./favicon.svg" alt="" aria-hidden="true" />
          <span className="text-lg font-semibold tracking-tight text-heading">{AUTH_COPY.brandName}</span>
        </div>
        <Card className="surface-card w-full">
          {authState === 'checking' ? (
            <CardContent className="py-8">
              <p className="supporting-copy text-center">{AUTH_COPY.connecting}</p>
            </CardContent>
          ) : authState === 'api-key-error' ? (
            <>
              <CardHeader>
                <p className="eyebrow eyebrow-soft">Dashboard access</p>
                <h1 className="font-medium tracking-tight text-primary">{AUTH_COPY.apiKeyErrorHeading}</h1>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="supporting-copy">
                  {error ?? 'Canonry could not verify this session’s access, so the dashboard stayed locked.'}
                </p>
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => { window.location.reload() }}
                >
                  {AUTH_COPY.tryAgain}
                </Button>
              </CardContent>
            </>
          ) : invitationFailed ? (
            <>
              <CardHeader>
                <h1 className="font-medium tracking-tight text-primary">{AUTH_COPY.invitationHeading}</h1>
              </CardHeader>
              <CardContent className="space-y-4">
                <p role="alert" className="supporting-copy">{AUTH_COPY.invitationFailed}</p>
                <Button type="button" className="w-full" onClick={() => { window.location.replace(`${_BASE_PREFIX}/`) }}>
                  {account ? AUTH_COPY.backToDashboard : AUTH_COPY.backToSignIn}
                </Button>
              </CardContent>
            </>
          ) : invitationFlow ? (
            <>
              <CardHeader>
                <p className="eyebrow eyebrow-soft">Dashboard invitation</p>
                <h1 className="font-medium tracking-tight text-primary">{AUTH_COPY.invitationHeading}</h1>
                <CardDescription>{AUTH_COPY.invitationInstruction}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {error ? <p role="alert" className="text-sm text-negative-400">{error}</p> : null}
                {account ? (
                  <>
                    <p className="supporting-copy">{AUTH_COPY.invitationSignedInInstruction}</p>
                    <Button type="button" className="w-full" disabled={submitting} onClick={asyncHandler(handleInvitationSignOut)}>
                      {AUTH_COPY.signOutToAcceptInvitation}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button type="button" className="w-full" disabled={submitting || googleEnabled !== true} onClick={asyncHandler(handleGoogleSignIn)}>
                      {AUTH_COPY.continueWithGoogle}
                    </Button>
                    {googleEnabled === null ? <p className="supporting-copy" role="status">{AUTH_COPY.checkingSignInOptions}</p> : null}
                    {googleEnabled === false ? <p className="supporting-copy">{AUTH_COPY.invitationUnavailable}</p> : null}
                  </>
                )}
              </CardContent>
            </>
          ) : authState === 'account-login' ? (
            <>
              <CardHeader>
                <p className="eyebrow eyebrow-soft">Dashboard access</p>
                <h1 className="font-medium tracking-tight text-primary">{AUTH_COPY.signInHeading}</h1>
              </CardHeader>
              <CardContent>
                {googleCallbackError === 'google-sign-in-failed' ? (
                  <p className="mb-4 rounded-md border border-caution bg-caution-soft px-3 py-2 text-sm text-caution" role="alert">
                    Google sign-in did not complete. Try again or use your password.
                  </p>
                ) : null}
                {sessionExpired ? (
                  <p className="mb-4 rounded-md border border-caution bg-caution-soft px-3 py-2 text-sm text-caution">
                    You were signed out — please sign in again.
                  </p>
                ) : null}
                {googleEnabled === null ? (
                  <p className="supporting-copy" role="status">{AUTH_COPY.checkingSignInOptions}</p>
                ) : googleEnabled && !useAccountPassword ? (
                  <div className="space-y-3">
                    <Button type="button" className="w-full" disabled={submitting} onClick={asyncHandler(handleGoogleSignIn)}>
                      {AUTH_COPY.continueWithGoogle}
                    </Button>
                    <Button type="button" variant="ghost" className="w-full" disabled={submitting} onClick={() => { setUseAccountPassword(true); setError(null) }}>
                      {AUTH_COPY.usePassword}
                    </Button>
                  </div>
                ) : (
                <form className="space-y-4" onSubmit={asyncHandler(handleAccountSignIn)}>
                  <label className="block space-y-1.5" htmlFor="account-name">
                    <span className="text-xs font-medium text-secondary">{AUTH_COPY.usernameLabel}</span>
                    <input
                      autoFocus
                      id="account-name"
                      className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none transition focus:border-mono-600"
                      type="text"
                      name="username"
                      autoComplete="username"
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value)
                        setError(null)
                      }}
                      aria-invalid={Boolean(error)}
                      aria-describedby={error ? 'account-login-error' : undefined}
                    />
                  </label>
                  <label className="block space-y-1.5" htmlFor="account-password">
                    <span className="text-xs font-medium text-secondary">{AUTH_COPY.passwordLabel}</span>
                    <input
                      id="account-password"
                      className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none transition focus:border-mono-600"
                      type="password"
                      name="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => updatePassword(event.target.value)}
                      aria-invalid={Boolean(error)}
                      aria-describedby={error ? 'account-login-error' : undefined}
                    />
                  </label>
                  {error ? <p id="account-login-error" role="alert" className="text-sm text-negative-400">{error}</p> : null}
                  <Button type="submit" className="w-full" disabled={submitting || !name.trim() || !password}>
                    {submitting ? 'Signing in…' : AUTH_COPY.signIn}
                  </Button>
                  {googleEnabled ? (
                    <Button type="button" variant="ghost" className="w-full" disabled={submitting} onClick={() => { setUseAccountPassword(false); setError(null) }}>
                      {AUTH_COPY.useGoogle}
                    </Button>
                  ) : null}
                </form>
                )}
              </CardContent>
            </>
          ) : authState === 'setup' ? (
            <>
              <CardHeader>
                <p className="eyebrow eyebrow-soft">First-time setup</p>
                <h1 className="font-medium tracking-tight text-primary">{AUTH_COPY.createAdministratorHeading}</h1>
                <CardDescription>
                  Create the first account for this Canonry install. {AUTH_COPY.googleOptional}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={asyncHandler(handleSetup)}>
                  <div className="space-y-1.5">
                    <label className="block space-y-1.5" htmlFor="administrator-name">
                      <span className="text-xs font-medium text-secondary">{AUTH_COPY.usernameLabel}</span>
                      <input
                        autoFocus
                        id="administrator-name"
                        className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none transition focus:border-mono-600"
                        type="text"
                        name="username"
                        autoComplete="username"
                        maxLength={64}
                        required
                        value={name}
                        onChange={(event) => { setName(event.target.value); setError(null) }}
                        aria-invalid={Boolean(setupNameError)}
                        aria-describedby={setupNameError ? 'administrator-name-help' : undefined}
                      />
                    </label>
                    {setupNameError ? <span id="administrator-name-help" className="block text-sm text-negative-400">{setupNameError}</span> : null}
                  </div>
                  <label className="block space-y-1.5" htmlFor="administrator-setup-key">
                    <span className="text-xs font-medium text-secondary">{AUTH_COPY.setupKeyLabel}</span>
                    <input
                      id="administrator-setup-key"
                      className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none transition focus:border-mono-600"
                      type="password"
                      name="setup-key"
                      autoComplete="off"
                      spellCheck={false}
                      value={setupKey}
                      onChange={(event) => { setSetupKey(event.target.value); setError(null) }}
                    />
                  </label>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-secondary" htmlFor="dashboard-password-new">
                      {AUTH_COPY.passwordLabel}
                    </label>
                    <input
                      id="dashboard-password-new"
                      className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none transition focus:border-mono-600"
                      type={showPassword ? 'text' : 'password'}
                      name="new-password"
                      autoComplete="new-password"
                      minLength={USER_PASSWORD_MIN_LENGTH}
                      required
                      value={password}
                      onChange={(event) => updatePassword(event.target.value)}
                      aria-invalid={setupPasswordIsShort}
                      aria-describedby="dashboard-password-new-help"
                    />
                    <span
                      id="dashboard-password-new-help"
                      aria-live="polite"
                      className={setupPasswordIsShort ? 'block text-sm text-negative-400' : 'block text-sm text-secondary'}
                    >
                      {setupPasswordIsShort ? AUTH_COPY.shortPasswordHelp : AUTH_COPY.minPasswordHelp}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-secondary" htmlFor="dashboard-password-confirm">
                      {AUTH_COPY.confirmPasswordLabel}
                    </label>
                    <input
                      id="dashboard-password-confirm"
                      className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none transition focus:border-mono-600"
                      type={showPassword ? 'text' : 'password'}
                      name="confirm-password"
                      autoComplete="new-password"
                      minLength={USER_PASSWORD_MIN_LENGTH}
                      required
                      value={confirmPassword}
                      onChange={(event) => updateConfirmPassword(event.target.value)}
                      aria-invalid={setupConfirmationMismatch}
                      aria-describedby="dashboard-password-confirm-help"
                    />
                    <span
                      id="dashboard-password-confirm-help"
                      aria-live="polite"
                      className={setupConfirmationMismatch ? 'block text-sm text-negative-400' : 'block text-sm text-secondary'}
                    >
                      {setupConfirmationMismatch ? AUTH_COPY.passwordsDoNotMatch : 'Enter the same password again.'}
                    </span>
                  </div>
                  <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-secondary" htmlFor="dashboard-password-show">
                    <input
                      id="dashboard-password-show"
                      type="checkbox"
                      checked={showPassword}
                      onChange={(event) => setShowPassword(event.target.checked)}
                    />
                    Show passwords
                  </label>
                  {error ? <p id="dashboard-password-setup-error" role="alert" className="text-sm text-negative-400">{error}</p> : null}
                  <Button type="submit" className="w-full" disabled={submitting || !setupFormIsValid}>
                    {submitting ? AUTH_COPY.creatingAdministrator : AUTH_COPY.createAdministrator}
                  </Button>
                </form>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader>
                <p className="eyebrow eyebrow-soft">Dashboard access</p>
                <h1 className="font-medium tracking-tight text-primary">Sign in to Canonry</h1>
                <CardDescription>
                  {sharedLoginMethod === 'api-key'
                    ? AUTH_COPY.legacyRecoveryDescription
                    : 'Enter your dashboard password to continue.'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {sessionExpired ? (
                  <p className="mb-4 rounded-md border border-caution bg-caution-soft px-3 py-2 text-sm text-caution">
                    {AUTH_COPY.legacySessionExpired}
                  </p>
                ) : null}
                <form className="space-y-4" onSubmit={asyncHandler(handleLogin)}>
                  <label className="block space-y-1.5" htmlFor="dashboard-password-current">
                    <span className="text-xs font-medium text-secondary">
                      {sharedLoginMethod === 'api-key' ? AUTH_COPY.apiKeyLabel : AUTH_COPY.passwordLabel}
                    </span>
                    <input
                      autoFocus
                      id="dashboard-password-current"
                      className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none transition focus:border-mono-600"
                      type={showPassword ? 'text' : 'password'}
                      name={sharedLoginMethod === 'api-key' ? 'apiKey' : 'password'}
                      autoComplete={sharedLoginMethod === 'api-key' ? 'off' : 'current-password'}
                      spellCheck={false}
                      required
                      value={password}
                      onChange={(event) => updatePassword(event.target.value)}
                      aria-invalid={Boolean(error)}
                      aria-describedby={error ? 'dashboard-password-login-error' : undefined}
                    />
                  </label>
                  <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-secondary" htmlFor="dashboard-login-password-show">
                    <input
                      id="dashboard-login-password-show"
                      type="checkbox"
                      checked={showPassword}
                      onChange={(event) => setShowPassword(event.target.checked)}
                    />
                    {sharedLoginMethod === 'api-key' ? 'Show API key' : 'Show password'}
                  </label>
                  {error ? <p id="dashboard-password-login-error" role="alert" className="text-sm text-negative-400">{error}</p> : null}
                  <Button type="submit" disabled={submitting || !password.trim()}>
                    {submitting ? 'Signing in…' : AUTH_COPY.openDashboard}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => changeSharedLoginMethod(sharedLoginMethod === 'api-key' ? 'password' : 'api-key')}
                  >
                    {sharedLoginMethod === 'api-key' ? AUTH_COPY.useDashboardPassword : AUTH_COPY.recoverWithApiKey}
                  </Button>
                  {!accountsInUse ? (
                    <Button type="button" variant="ghost" onClick={() => { setAuthState('setup'); setError(null); setPassword(''); setShowPassword(false) }}>
                      {AUTH_COPY.createAdministrator}
                    </Button>
                  ) : null}
                </form>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
