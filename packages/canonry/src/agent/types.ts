/**
 * Agent types — shared across the agent module.
 */

export interface AgentThread {
  id: string
  projectId: string
  title: string | null
  channel: string
  createdAt: string
  updatedAt: string
}

export interface AgentMessage {
  id: string
  threadId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName: string | null
  toolArgs: string | null
  toolCallId: string | null
  createdAt: string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string>
}

export interface AgentConfig {
  provider: 'openai' | 'claude' | 'gemini'
  apiKey: string
  model?: string
  maxSteps?: number
  maxHistoryMessages?: number
}
