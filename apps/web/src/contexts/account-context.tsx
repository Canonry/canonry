/**
 * Who is signed in, for the parts of the dashboard that have to care.
 *
 * Most of the app does not: a viewer can open every screen that only reads.
 * This context exists for the handful of places that offer to CHANGE something
 * — starting a run, publishing a plan, opening settings — so they can be honest
 * about it up front instead of letting somebody fill in a form and then be
 * refused.
 *
 * Hiding a control is never the security boundary. The server refuses the same
 * request whether or not the button was drawn; this is only about not wasting
 * somebody's time.
 */
import { createContext, useContext, type ReactNode } from 'react'
import { UserRoles, userRoleScopes, WILDCARD_SCOPE, type ApiKeyDto, type UserRole } from '@ainyc/canonry-contracts'

export interface SignedInAccount {
  /** Account sessions always supply these; optional keeps older embedded test harnesses compatible. */
  id?: string
  name: string
  role: UserRole
  authVersion?: number
  displayName?: string | null
}

export interface AccountState {
  /** Null on an install with no accounts, where everyone has full access. */
  account: SignedInAccount | null
  /** True when this person may change things. Also true when nobody signed in. */
  canWrite: boolean
  /** True when the named account can use the bounded Research workspace. */
  canResearch: boolean
  /** True when administrator-only screens should be offered. */
  isAdmin: boolean
}

const NO_ACCOUNTS: AccountState = { account: null, canWrite: true, canResearch: true, isAdmin: true }
const RESTRICTED_API_KEY: AccountState = { account: null, canWrite: false, canResearch: false, isAdmin: false }

export type ApiKeyAccess = Pick<ApiKeyDto, 'id' | 'scopes' | 'projectId' | 'readOnly'>

/**
 * Map a key's coarse authority onto the dashboard's two existing affordance
 * gates. Named scopes stay restricted: this context cannot honestly turn a
 * domain-specific grant such as `ads.write` into permission for every write
 * control in the application.
 */
export function accountStateForApiKey(apiKey: ApiKeyAccess): AccountState {
  const hasGeneralWrite = apiKey.scopes.includes(WILDCARD_SCOPE)
  return {
    account: null,
    canWrite: !apiKey.readOnly && hasGeneralWrite,
    canResearch: !apiKey.readOnly && (hasGeneralWrite || apiKey.scopes.includes('research.run')),
    isAdmin: apiKey.projectId === null && apiKey.scopes.includes(WILDCARD_SCOPE),
  }
}

const AccountContext = createContext<AccountState>(NO_ACCOUNTS)

export function AccountProvider({
  account,
  apiKey,
  apiKeyPending = false,
  children,
}: {
  account: SignedInAccount | null
  apiKey?: ApiKeyAccess | null
  /** Explicit browser keys render fail-closed until `/keys/self` resolves. */
  apiKeyPending?: boolean
  children: ReactNode
}) {
  const value: AccountState = apiKeyPending
    ? RESTRICTED_API_KEY
    : apiKey
      ? accountStateForApiKey(apiKey)
      : account
        ? {
            account,
            canWrite: account.role === UserRoles.admin,
            canResearch: userRoleScopes(account.role).includes(WILDCARD_SCOPE) || account.role === UserRoles.analyst,
            isAdmin: account.role === UserRoles.admin,
          }
        : NO_ACCOUNTS

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>
}

/**
 * The current person's access.
 *
 * Defaults to full access, which is what an install with no accounts has and
 * what every existing screen already assumed. A screen that forgets to consult
 * this therefore behaves exactly as it does today rather than locking anyone
 * out by accident.
 */
export function useAccount(): AccountState {
  return useContext(AccountContext)
}

/** The label a view-only person is shown in place of a control they cannot use. */
export const VIEW_ONLY_LABEL = 'View only — your account cannot change this.'
