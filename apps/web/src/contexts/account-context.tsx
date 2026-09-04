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
import { WILDCARD_SCOPE, type ApiKeyDto } from '@ainyc/canonry-contracts'

export interface SignedInAccount {
  name: string
  role: 'admin' | 'viewer'
}

export interface AccountState {
  /** Null on an install with no accounts, where everyone has full access. */
  account: SignedInAccount | null
  /** True when this person may change things. Also true when nobody signed in. */
  canWrite: boolean
  /** True when administrator-only screens should be offered. */
  isAdmin: boolean
}

const NO_ACCOUNTS: AccountState = { account: null, canWrite: true, isAdmin: true }
const RESTRICTED_API_KEY: AccountState = { account: null, canWrite: false, isAdmin: false }

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
        ? { account, canWrite: account.role === 'admin', isAdmin: account.role === 'admin' }
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
