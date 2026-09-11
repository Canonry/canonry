import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { UserRoles, UserStatuses, type UserRole } from '@ainyc/canonry-contracts'

import {
  ApiError,
  createUserInvitation,
  fetchGoogleSignInSettings,
  fetchUserAccessHistory,
  fetchUserInvitations,
  fetchUsers,
  replaceUserInvitation,
  revokeUserAccess,
  revokeUserInvitation,
  updateGoogleSignInSettings,
  updateUser,
  type ApiUser,
} from '../../api.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { Button } from '../ui/button.js'
import { ToneBadge } from '../shared/ToneBadge.js'

const USERS_KEY = ['people-access', 'users'] as const
const INVITATIONS_KEY = ['people-access', 'invitations'] as const
const GOOGLE_SETTINGS_KEY = ['people-access', 'google-settings'] as const

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Never'
}

function invitationTone(status: 'pending' | 'accepted' | 'revoked' | 'expired') {
  return status === 'accepted' ? 'positive' : status === 'pending' ? 'caution' : 'neutral'
}

async function copy(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

/** Compact instance-level access administration. It owns its reads so unrelated provider settings cannot delay it. */
export function PeopleAccessSection() {
  const queryClient = useQueryClient()
  const usersQuery = useQuery({ queryKey: USERS_KEY, queryFn: fetchUsers })
  const invitationsQuery = useQuery({ queryKey: INVITATIONS_KEY, queryFn: fetchUserInvitations })
  const googleQuery = useQuery({ queryKey: GOOGLE_SETTINGS_KEY, queryFn: fetchGoogleSignInSettings })
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<UserRole>(UserRoles.viewer)
  const [link, setLink] = useState<string | null>(null)
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null)
  const historyQuery = useQuery({ queryKey: ['people-access', 'history', selectedHistoryId], queryFn: () => fetchUserAccessHistory(selectedHistoryId!), enabled: selectedHistoryId !== null })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [showGoogle, setShowGoogle] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: USERS_KEY }),
      queryClient.invalidateQueries({ queryKey: INVITATIONS_KEY }),
    ])
  }
  const run = async (action: () => Promise<void>) => {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The access change could not be saved. Try again.')
    } finally {
      setPending(false)
    }
  }
  const invite = () => run(async () => {
    const result = await createUserInvitation({ email: email.trim(), role })
    setEmail('')
    setLink(result.invitationUrl)
    await refresh()
  })
  const changeUser = (user: ApiUser, body: Parameters<typeof updateUser>[1]) => run(async () => {
    await updateUser(user.id, body)
    await queryClient.invalidateQueries({ queryKey: USERS_KEY })
  })
  const saveGoogle = () => run(async () => {
    const body = {
      enabled: googleQuery.data?.enabled,
      clientId: clientId.trim() || undefined,
      clientSecret: clientSecret || undefined,
    }
    await updateGoogleSignInSettings(body)
    setClientSecret('')
    await queryClient.invalidateQueries({ queryKey: GOOGLE_SETTINGS_KEY })
  })

  return (
    <section className="page-section-divider" aria-labelledby="people-access-heading">
      <div className="section-head">
        <div>
          <p className="eyebrow eyebrow-soft">Instance access</p>
          <h2 id="people-access-heading">People &amp; access</h2>
        </div>
      </div>
      <p className="max-w-prose text-sm text-secondary">Invited people receive access to this Canonry install and every project in it.</p>

      <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={asyncHandler(async event => { event.preventDefault(); await invite() })}>
        <label className="min-w-56 flex-1 space-y-1" htmlFor="invite-email">
          <span className="text-xs font-medium text-secondary">Email</span>
          <input id="invite-email" className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none focus:border-mono-600" type="email" required value={email} onChange={event => setEmail(event.target.value)} />
        </label>
        <label className="space-y-1" htmlFor="invite-role">
          <span className="text-xs font-medium text-secondary">Role</span>
          <select id="invite-role" className="rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading" value={role} onChange={event => setRole(event.target.value as UserRole)}>
            <option value={UserRoles.viewer}>Viewer</option>
            <option value={UserRoles.analyst}>Analyst</option>
            <option value={UserRoles.admin}>Admin</option>
          </select>
        </label>
        <Button type="submit" disabled={pending || !email.trim() || !googleQuery.data?.enabled || !googleQuery.data.configured}>Create invitation</Button>
      </form>
      {googleQuery.data && (!googleQuery.data.enabled || !googleQuery.data.configured) ? <p className="mt-2 text-sm text-secondary">Set up Google sign-in below before inviting people.</p> : null}
      {link ? <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-caution bg-caution-soft px-3 py-2 text-sm"><span>Single-use invitation link ready.</span><Button type="button" size="sm" variant="outline" onClick={asyncHandler(async () => { if (!(await copy(link))) setError('The invitation link could not be copied.') })}>Copy link</Button></div> : null}
      {error ? <p role="alert" className="mt-3 text-sm text-negative">{error}</p> : null}

      <div className="mt-5 overflow-x-auto border-y border-default">
        <table className="w-full min-w-180 text-left text-sm">
          <thead className="text-xs text-secondary"><tr><th className="px-3 py-2">Person</th><th className="px-3 py-2">Email</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Last sign-in</th><th className="px-3 py-2" aria-label="Actions" /></tr></thead>
          <tbody className="divide-y divide-default">
            {(usersQuery.data?.users ?? []).map(user => <UserRow key={user.id} user={user} pending={pending} onUpdate={(row, body) => { void changeUser(row, body) }} onRevoke={() => { void run(async () => { await revokeUserAccess(user.id); await queryClient.invalidateQueries({ queryKey: USERS_KEY }) }) }} onHistory={() => setSelectedHistoryId(user.id)} />)}
          </tbody>
        </table>
      </div>
      {usersQuery.isLoading ? <p className="mt-3 text-sm text-secondary" role="status">Loading people…</p> : null}
      {usersQuery.isError ? <p className="mt-3 text-sm text-negative" role="alert">People could not be loaded.</p> : null}

      {(invitationsQuery.data?.invitations.length ?? 0) > 0 ? <div className="mt-4 overflow-x-auto"><h3 className="font-medium text-heading">Invitations</h3><table className="mt-2 w-full min-w-160 text-left text-sm"><thead className="text-xs text-secondary"><tr><th className="px-3 py-2">Email</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">State</th><th className="px-3 py-2">Expires</th><th className="px-3 py-2" aria-label="Actions" /></tr></thead><tbody className="divide-y divide-default">{invitationsQuery.data!.invitations.map(invitation => <tr key={invitation.id}><td className="px-3 py-2">{invitation.email}</td><td className="px-3 py-2 capitalize">{invitation.role}</td><td className="px-3 py-2"><ToneBadge tone={invitationTone(invitation.status)}>{invitation.status}</ToneBadge></td><td className="px-3 py-2">{date(invitation.expiresAt)}</td><td className="px-3 py-2"><div className="flex gap-2">{invitation.status === 'pending' ? <><Button type="button" size="sm" variant="ghost" disabled={pending} onClick={asyncHandler(() => run(async () => { const result = await replaceUserInvitation(invitation.id); setLink(result.invitationUrl); await refresh() }))}>Replace link</Button><Button type="button" size="sm" variant="ghost" disabled={pending} onClick={asyncHandler(() => run(async () => { await revokeUserInvitation(invitation.id); await refresh() }))}>Revoke</Button></> : null}</div></td></tr>)}</tbody></table></div> : null}

      {selectedHistoryId ? <details open className="mt-4 border-t border-default pt-3"><summary className="cursor-pointer text-sm font-medium text-secondary">Access history</summary>{historyQuery.isLoading ? <p className="mt-2 text-sm text-secondary">Loading history…</p> : null}{historyQuery.isError ? <p className="mt-2 text-sm text-negative">History could not be loaded.</p> : null}<ul className="mt-2 space-y-1 text-sm text-secondary">{historyQuery.data?.events.map(event => <li key={event.id}>{event.action} · {event.actorName ?? 'System'} · {date(event.createdAt)}</li>)}</ul></details> : null}

      <details className="mt-5 border-t border-default pt-3" open={showGoogle} onToggle={event => setShowGoogle(event.currentTarget.open)}>
        <summary className="cursor-pointer text-sm font-medium text-secondary">Google sign-in setup</summary>
        <div className="mt-3 max-w-xl space-y-3">
          {googleQuery.isError ? <p role="alert" className="text-sm text-negative">Google sign-in settings could not be loaded.</p> : null}
          {googleQuery.isLoading ? <p className="text-sm text-secondary">Loading Google sign-in setup…</p> : null}
          {googleQuery.data ? <><p className="text-sm text-secondary">{googleQuery.data.environmentOverride ? 'Configured by this environment and not editable here.' : 'Use a separate Google OAuth app for dashboard sign-in.'}</p><label className="block space-y-1" htmlFor="google-sign-in-client-id"><span className="text-xs font-medium text-secondary">Client ID</span><input id="google-sign-in-client-id" className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading" disabled={!googleQuery.data.editable} placeholder={googleQuery.data.clientId ?? undefined} value={clientId} onChange={event => setClientId(event.target.value)} /></label><label className="block space-y-1" htmlFor="google-sign-in-secret"><span className="text-xs font-medium text-secondary">Replace client secret</span><input id="google-sign-in-secret" className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading" type="password" disabled={!googleQuery.data.editable} value={clientSecret} onChange={event => setClientSecret(event.target.value)} /></label><div className="flex flex-wrap items-center gap-2"><Button type="button" size="sm" variant="outline" disabled={!googleQuery.data.callbackUrl} onClick={asyncHandler(async () => { if (googleQuery.data.callbackUrl && !(await copy(googleQuery.data.callbackUrl))) setError('The callback URL could not be copied.') })}>Copy callback URL</Button><label className="flex items-center gap-2 text-sm text-secondary"><input type="checkbox" disabled={!googleQuery.data.editable} checked={googleQuery.data.enabled} onChange={event => { void run(async () => { await updateGoogleSignInSettings({ enabled: event.target.checked }); await queryClient.invalidateQueries({ queryKey: GOOGLE_SETTINGS_KEY }) }) }} />Enable Google sign-in</label><Button type="button" size="sm" disabled={!googleQuery.data.editable || pending || (!clientId.trim() && !clientSecret)} onClick={asyncHandler(saveGoogle)}>Save</Button></div></> : null}
        </div>
      </details>
    </section>
  )
}

function UserRow({ user, pending, onUpdate, onRevoke, onHistory }: { user: ApiUser; pending: boolean; onUpdate: (user: ApiUser, body: Parameters<typeof updateUser>[1]) => void; onRevoke: () => void; onHistory: () => void }) {
  const [editing, setEditing] = useState(false)
  const [displayName, setDisplayName] = useState(user.displayName ?? '')
  const [email, setEmail] = useState(user.email ?? '')
  return <><tr><td className="px-3 py-2">{user.displayName ?? user.name}</td><td className="px-3 py-2">{user.email ?? 'No email'}</td><td className="px-3 py-2"><select aria-label={`Role for ${user.name}`} className="bg-transparent" value={user.role} disabled={pending} onChange={event => onUpdate(user, { role: event.target.value as UserRole })}><option value={UserRoles.viewer}>Viewer</option><option value={UserRoles.analyst}>Analyst</option><option value={UserRoles.admin}>Admin</option></select></td><td className="px-3 py-2"><select aria-label={`Status for ${user.name}`} className="bg-transparent" value={user.status} disabled={pending} onChange={event => onUpdate(user, { status: event.target.value as ApiUser['status'] })}><option value={UserStatuses.active}>Active</option><option value={UserStatuses.suspended}>Suspended</option></select></td><td className="px-3 py-2">{date(user.lastLoginAt)}</td><td className="px-3 py-2"><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setEditing(value => !value)}>Details</Button><Button type="button" size="sm" variant="ghost" onClick={onHistory}>History</Button><Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onRevoke}>Revoke access</Button></div></td></tr>{editing ? <tr><td className="px-3 py-2" colSpan={6}><p className="mb-2 text-xs text-secondary">Last active: {date(user.lastSeenAt)}</p><div className="flex flex-wrap items-end gap-2"><label className="space-y-1"><span className="block text-xs text-secondary">Display name</span><input className="rounded border border-base bg-bg px-2 py-1 text-sm" value={displayName} onChange={event => setDisplayName(event.target.value)} /></label><label className="space-y-1"><span className="block text-xs text-secondary">Email</span><input className="rounded border border-base bg-bg px-2 py-1 text-sm" type="email" value={email} onChange={event => setEmail(event.target.value)} /></label><Button type="button" size="sm" disabled={pending} onClick={() => onUpdate(user, { displayName: displayName.trim() || null, email: email.trim() || null })}>Save details</Button></div></td></tr> : null}</>
}
