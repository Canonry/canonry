import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserDto, UserListDto } from '@canonry/canonry-contracts'

const mockListUsers = vi.fn()
const mockCreateUser = vi.fn()
const mockDeleteUser = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    listUsers: mockListUsers,
    createUser: mockCreateUser,
    deleteUser: mockDeleteUser,
  }),
}))

const mockPromptPassword = vi.fn()
vi.mock('../src/cli-prompt.js', () => ({
  promptHiddenInput: mockPromptPassword,
}))

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return { logs, restore: () => { console.log = orig } }
}

const { listUsers, createUser, deleteUser } = await import('../src/commands/users.js')

const USERS: UserDto[] = [
  { id: 'u1', name: 'owner', role: 'admin', createdAt: '2026-05-01T00:00:00.000Z', lastLoginAt: '2026-05-30T00:00:00.000Z' },
  { id: 'u2', name: 'watcher', role: 'viewer', createdAt: '2026-05-02T00:00:00.000Z', lastLoginAt: null },
]

describe('user list', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders a table of names, roles and last sign-in', async () => {
    mockListUsers.mockResolvedValue({ users: USERS } satisfies UserListDto)
    const cap = captureLog()
    try {
      await listUsers(undefined)
    } finally {
      cap.restore()
    }
    const out = cap.logs.join('\n')
    expect(out).toContain('NAME')
    expect(out).toContain('ROLE')
    expect(out).toContain('owner')
    expect(out).toContain('admin')
    expect(out).toContain('watcher')
    expect(out).toContain('viewer')
    // Nothing password-shaped ever reaches the terminal.
    expect(out).not.toMatch(/passwordHash|scrypt/i)
  })

  it('says plainly when nobody has to sign in yet', async () => {
    mockListUsers.mockResolvedValue({ users: [] } satisfies UserListDto)
    const cap = captureLog()
    try {
      await listUsers(undefined)
    } finally {
      cap.restore()
    }
    expect(cap.logs.join('\n')).toMatch(/no accounts/i)
    expect(cap.logs.join('\n')).toMatch(/opens without a sign-in/i)
  })

  it('format=json prints the full envelope', async () => {
    mockListUsers.mockResolvedValue({ users: USERS } satisfies UserListDto)
    const cap = captureLog()
    try {
      await listUsers('json')
    } finally {
      cap.restore()
    }
    expect(JSON.parse(cap.logs.join(''))).toEqual({ users: USERS })
  })
})

describe('user create', () => {
  beforeEach(() => vi.clearAllMocks())

  const created: UserDto = {
    id: 'u3',
    name: 'newcomer',
    role: 'viewer',
    createdAt: '2026-05-31T00:00:00.000Z',
    lastLoginAt: null,
  }

  it('asks for the password rather than taking it from the command line', async () => {
    mockPromptPassword.mockResolvedValue('a-long-enough-password')
    mockCreateUser.mockResolvedValue(created)
    const cap = captureLog()
    try {
      await createUser({ name: 'newcomer', role: 'viewer', format: undefined })
    } finally {
      cap.restore()
    }
    expect(mockPromptPassword).toHaveBeenCalled()
    expect(mockCreateUser).toHaveBeenCalledWith({
      name: 'newcomer',
      role: 'viewer',
      password: 'a-long-enough-password',
    })
    // The password never appears in what the terminal shows.
    expect(cap.logs.join('\n')).not.toContain('a-long-enough-password')
  })

  it('reads the password from standard input when asked to', async () => {
    mockCreateUser.mockResolvedValue(created)
    const cap = captureLog()
    try {
      await createUser({
        name: 'newcomer',
        role: 'viewer',
        passwordStdin: true,
        readStdin: async () => 'piped-in-password-here\n',
        format: undefined,
      })
    } finally {
      cap.restore()
    }
    expect(mockPromptPassword).not.toHaveBeenCalled()
    expect(mockCreateUser).toHaveBeenCalledWith({
      name: 'newcomer',
      role: 'viewer',
      password: 'piped-in-password-here',
    })
  })

  it('says what creating the first account changes', async () => {
    mockPromptPassword.mockResolvedValue('a-long-enough-password')
    mockListUsers.mockResolvedValue({ users: [] } satisfies UserListDto)
    mockCreateUser.mockResolvedValue({ ...created, role: 'admin' })
    const cap = captureLog()
    try {
      await createUser({ name: 'newcomer', role: 'admin', format: undefined })
    } finally {
      cap.restore()
    }
    expect(cap.logs.join('\n')).toMatch(/first account/i)
    expect(cap.logs.join('\n')).toMatch(/sign in/i)
  })

  it('refuses a role it does not have', async () => {
    await expect(
      createUser({ name: 'newcomer', role: 'superuser', format: undefined }),
    ).rejects.toThrow(/admin|viewer/i)
    expect(mockCreateUser).not.toHaveBeenCalled()
  })

  it('refuses when the two typed passwords differ', async () => {
    mockPromptPassword
      .mockResolvedValueOnce('a-long-enough-password')
      .mockResolvedValueOnce('a-different-password-x')
    await expect(
      createUser({ name: 'newcomer', role: 'viewer', format: undefined }),
    ).rejects.toThrow(/do not match/i)
    expect(mockCreateUser).not.toHaveBeenCalled()
  })
})

describe('user delete', () => {
  beforeEach(() => vi.clearAllMocks())

  it('confirms the deletion in plain words', async () => {
    mockDeleteUser.mockResolvedValue({ deleted: true, name: 'watcher' })
    const cap = captureLog()
    try {
      await deleteUser('watcher', undefined)
    } finally {
      cap.restore()
    }
    expect(cap.logs.join('\n')).toMatch(/watcher/)
    expect(cap.logs.join('\n')).toMatch(/deleted|removed/i)
    expect(mockDeleteUser).toHaveBeenCalledWith('watcher')
  })
})
