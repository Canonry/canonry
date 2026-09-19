import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import {
  fetchAccountSessions,
  fetchAuthMethods,
  fetchAuthProviders,
  linkGoogleSignIn,
  revokeAllAccountSessions,
  unlinkAuthMethod,
} from '../../api.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { Button } from '../ui/button.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { Drawer } from '../layout/Drawer.js'
import { useAccount } from '../../contexts/account-context.js'
import { UserRoles } from '@ainyc/canonry-contracts'

const ACCOUNT_METHODS_KEY = ['account', 'methods'] as const
const ACCOUNT_SESSIONS_KEY = ['account', 'sessions'] as const

function readableTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : 'Unavailable'
}

/**
 * Self-service account controls deliberately live beside the signed-in identity
 * rather than in Settings: every signed-in role can manage its own sign-in
 * methods and sessions, while instance People & access remains admin-only.
 */
export function AccountPanel() {
  const { account } = useAccount()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const methodsQuery = useQuery({ queryKey: ACCOUNT_METHODS_KEY, queryFn: fetchAuthMethods, enabled: open })
  const sessionsQuery = useQuery({ queryKey: ACCOUNT_SESSIONS_KEY, queryFn: fetchAccountSessions, enabled: open })
  const providersQuery = useQuery({ queryKey: ['account', 'providers'], queryFn: fetchAuthProviders, enabled: open })
  const googleAvailable = providersQuery.data?.google.enabled === true && Boolean(providersQuery.data.google.startUrl)

  const hasPassword = methodsQuery.data?.methods.some(method => method.provider === 'password') === true
  const canRemoveGoogle = hasPassword || (googleAvailable && (methodsQuery.data?.methods.length ?? 0) > 1)

  const beginGoogleLink = async () => {
    if (!password) return
    setPending(true)
    setError(null)
    try {
      const { redirectUrl } = await linkGoogleSignIn(password)
      setPassword('')
      window.location.assign(redirectUrl)
    } catch {
      setError('Google sign-in could not be linked. Check your password and try again.')
    } finally {
      setPending(false)
    }
  }

  const unlink = async (id: string) => {
    setPending(true)
    setError(null)
    try {
      await unlinkAuthMethod(id)
      window.location.reload()
    } catch {
      setError('That sign-in method could not be removed.')
    } finally {
      setPending(false)
    }
  }

  const endAllSessions = async () => {
    setPending(true)
    setError(null)
    try {
      await revokeAllAccountSessions()
      window.location.reload()
    } catch {
      setError('Sessions could not be ended. Try again.')
      setPending(false)
    }
  }

  return (
    <>
      <Button type="button" variant="ghost" size="sm" className="h-auto min-w-0 flex-1 justify-start px-0 text-left" aria-label="Account" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span className="sidebar-account-identity">
          <span className="sidebar-account-name">{account?.displayName ?? account?.name}</span>
          <span className="sidebar-account-role">{account?.role === UserRoles.analyst ? 'Analyst' : account?.role === UserRoles.viewer ? 'View only' : 'Admin'}</span>
        </span>
      </Button>
      <Drawer title="Account" subtitle={account?.displayName ?? account?.name ?? ''} open={open} onClose={() => setOpen(false)}>
        <div className="space-y-5 text-sm">
          <section aria-labelledby="account-methods-heading">
            <div className="flex items-center justify-between gap-2">
              <h2 id="account-methods-heading" className="font-medium text-heading">Sign-in methods</h2>
              {methodsQuery.isFetching ? <ToneBadge tone="neutral">Loading</ToneBadge> : null}
            </div>
            {methodsQuery.isError ? <p className="mt-2 text-secondary">Sign-in methods are unavailable right now.</p> : null}
            <ul className="mt-2 space-y-2">
              {(methodsQuery.data?.methods ?? []).map(method => (
                <li key={method.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{method.provider === 'google' ? 'Google' : 'Password'}{method.email ? ` · ${method.email}` : ''}</span>
                  {method.provider === 'google' ? (
                    <Button type="button" variant="ghost" size="sm" disabled={pending || !canRemoveGoogle} title={!canRemoveGoogle ? 'Keep at least one sign-in method.' : undefined} onClick={asyncHandler(() => unlink(method.id))}>Remove</Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {googleAvailable && hasPassword ? <><label className="mt-3 block space-y-1" htmlFor="account-link-password">
              <span className="text-xs font-medium text-secondary">Password to link Google</span>
              <input
                id="account-link-password"
                className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none focus:border-mono-600"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={event => setPassword(event.target.value)}
              />
            </label>
            <Button type="button" variant="outline" size="sm" className="mt-2" disabled={!password || pending} onClick={asyncHandler(beginGoogleLink)}>
              Link Google
            </Button>
            </> : null}
          </section>

          <section aria-labelledby="account-sessions-heading">
            <h2 id="account-sessions-heading" className="font-medium text-heading">Sessions</h2>
            {sessionsQuery.isError ? <p className="mt-2 text-secondary">Session details are unavailable right now.</p> : null}
            <ul className="mt-2 space-y-1 text-secondary">
              {(sessionsQuery.data?.sessions ?? []).map(session => <li key={session.id}>Started {readableTime(session.createdAt)} · ends {readableTime(session.expiresAt)}</li>)}
            </ul>
            <Button type="button" variant="outline" size="sm" className="mt-2" disabled={pending} onClick={asyncHandler(endAllSessions)}>
              End all sessions
            </Button>
          </section>
          {error ? <p role="alert" className="text-negative">{error}</p> : null}
        </div>
      </Drawer>
    </>
  )
}
