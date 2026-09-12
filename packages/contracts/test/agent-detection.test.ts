import { describe, expect, it } from 'vitest'
import { AGENT_NONE, detectAgentRuntime, normalizeAgentSlug } from '../src/telemetry.js'

describe('detectAgentRuntime', () => {
  it('reports none for a plain shell', () => {
    expect(detectAgentRuntime({ PATH: '/usr/bin', TERM_PROGRAM: 'Apple_Terminal' })).toBe(AGENT_NONE)
  })

  it.each([
    [{ CLAUDECODE: '1' }, 'claude'],
    [{ CLAUDE_CODE: '1' }, 'claude'],
    [{ CLAUDECODE: '1', CLAUDE_CODE_IS_COWORK: '1' }, 'cowork'],
    [{ CURSOR_TRACE_ID: 'abc' }, 'cursor'],
    [{ CURSOR_AGENT: '1' }, 'cursor-cli'],
    [{ CURSOR_EXTENSION_HOST_ROLE: 'agent-exec' }, 'cursor-cli'],
    [{ GEMINI_CLI: '1' }, 'gemini'],
    [{ CODEX_SANDBOX: 'seatbelt' }, 'codex'],
    [{ CODEX_CI: '1' }, 'codex'],
    [{ CODEX_THREAD_ID: 't' }, 'codex'],
    [{ ANTIGRAVITY_AGENT: '1' }, 'antigravity'],
    [{ AUGMENT_AGENT: '1' }, 'augment-cli'],
    [{ OPENCODE_CLIENT: 'cli' }, 'opencode'],
    [{ REPL_ID: 'r' }, 'replit'],
    [{ COPILOT_MODEL: 'gpt' }, 'github-copilot'],
  ] as const)('maps %o to %s', (env, agent) => {
    expect(detectAgentRuntime(env)).toBe(agent)
  })

  it('drops the version Claude Code embeds in AI_AGENT, so a release is not a new agent', () => {
    // The literal value Claude Code sets for commands it runs.
    expect(detectAgentRuntime({ AI_AGENT: 'claude-code_2-1-270_agent', CLAUDECODE: '1' })).toBe('claude')
    expect(detectAgentRuntime({ AI_AGENT: 'claude-code_2-2-0_agent' })).toBe('claude')
  })

  it('takes AI_AGENT ahead of the per-agent table, as the reference implementation does', () => {
    expect(detectAgentRuntime({ AI_AGENT: 'v0', CLAUDECODE: '1' })).toBe('v0')
    expect(detectAgentRuntime({ AI_AGENT: 'github-copilot-cli' })).toBe('github-copilot')
  })

  it('lets CANONRY_AGENT label a harness the table does not know, and wins over detection', () => {
    expect(detectAgentRuntime({ CANONRY_AGENT: 'Acme Ops Bot', CLAUDECODE: '1' })).toBe('acme-ops-bot')
  })

  it('ignores an override that normalizes to nothing', () => {
    expect(detectAgentRuntime({ CANONRY_AGENT: '!!!', GEMINI_CLI: '1' })).toBe('gemini')
    expect(detectAgentRuntime({ AI_AGENT: '   ' })).toBe(AGENT_NONE)
  })
})

describe('normalizeAgentSlug', () => {
  it('lowercases, collapses separators, and bounds length', () => {
    expect(normalizeAgentSlug('Claude Desktop')).toBe('claude-desktop')
    expect(normalizeAgentSlug('codex-mcp-client')).toBe('codex-mcp-client')
    expect(normalizeAgentSlug('x'.repeat(80))).toHaveLength(40)
  })

  it('returns null when nothing usable remains', () => {
    expect(normalizeAgentSlug(undefined)).toBeNull()
    expect(normalizeAgentSlug('')).toBeNull()
    expect(normalizeAgentSlug('---')).toBeNull()
  })
})
