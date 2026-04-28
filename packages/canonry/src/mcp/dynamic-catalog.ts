import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CanonryMcpTool } from './tool-registry.js'
import {
  CANONRY_MCP_TOOLKITS,
  isCanonryMcpToolkitName,
  type CanonryMcpToolkit,
  type CanonryMcpToolkitName,
} from './toolkits.js'

export interface DynamicCatalogEntry {
  tool: CanonryMcpTool
  registered: RegisteredTool
}

export interface DynamicToolCatalogOptions {
  eager?: boolean
}

export interface ToolkitLoadResult {
  status: 'loaded' | 'already-loaded' | 'empty'
  name: CanonryMcpToolkitName
  tools: string[]
}

export interface ToolkitCatalogEntry {
  name: CanonryMcpToolkitName
  title: string
  description: string
  whenToLoad: string
  toolCount: number
  tools: string[]
  loaded: boolean
}

export interface HelpResult {
  scope: 'all' | 'read-only'
  eager: boolean
  loadedToolkits: CanonryMcpToolkitName[]
  coreTools: string[]
  toolkits: ToolkitCatalogEntry[]
  usage: string
}

type NotifierHost = { sendToolListChanged(): void }

export class DynamicToolCatalog {
  private readonly entries: DynamicCatalogEntry[]
  private readonly loaded = new Set<CanonryMcpToolkitName>()
  private readonly eager: boolean
  private readonly scope: 'all' | 'read-only'
  private readonly server: McpServer

  constructor(
    server: McpServer,
    entries: DynamicCatalogEntry[],
    scope: 'all' | 'read-only',
    options: DynamicToolCatalogOptions = {},
  ) {
    this.server = server
    this.entries = entries
    this.scope = scope
    this.eager = Boolean(options.eager)
    if (this.eager) {
      for (const toolkit of CANONRY_MCP_TOOLKITS) {
        if (this.toolsForToolkit(toolkit.name).length > 0) {
          this.loaded.add(toolkit.name)
        }
      }
    }
  }

  applyInitialEnablement(): void {
    if (this.eager) return
    this.batchListChanged(() => {
      for (const entry of this.entries) {
        if (entry.tool.tier !== 'core') entry.registered.disable()
      }
    })
  }

  loadToolkit(rawName: string): ToolkitLoadResult {
    if (!isCanonryMcpToolkitName(rawName)) {
      const valid = CANONRY_MCP_TOOLKITS.map(t => t.name).join(', ')
      throw new Error(`Unknown toolkit "${rawName}". Available: ${valid}.`)
    }
    const name: CanonryMcpToolkitName = rawName
    const matches = this.entries.filter(entry => entry.tool.tier === name)
    if (matches.length === 0) {
      return { status: 'empty', name, tools: [] }
    }
    if (this.loaded.has(name)) {
      return { status: 'already-loaded', name, tools: matches.map(entry => entry.tool.name) }
    }
    this.batchListChanged(() => {
      for (const entry of matches) {
        entry.registered.enable()
      }
    })
    this.loaded.add(name)
    return { status: 'loaded', name, tools: matches.map(entry => entry.tool.name) }
  }

  helpResult(): HelpResult {
    return {
      scope: this.scope,
      eager: this.eager,
      loadedToolkits: [...this.loaded].sort(),
      coreTools: this.entries
        .filter(entry => entry.tool.tier === 'core')
        .map(entry => entry.tool.name),
      toolkits: CANONRY_MCP_TOOLKITS.map(toolkit => this.toolkitEntry(toolkit)).filter(entry => entry.toolCount > 0),
      usage: 'Call canonry_load_toolkit with one of the toolkit names listed in `toolkits[].name` to register its tools for the rest of this session. Wait for its response before calling any newly enabled tool.',
    }
  }

  private toolkitEntry(toolkit: CanonryMcpToolkit): ToolkitCatalogEntry {
    const tools = this.toolsForToolkit(toolkit.name)
    return {
      name: toolkit.name,
      title: toolkit.title,
      description: toolkit.description,
      whenToLoad: toolkit.whenToLoad,
      toolCount: tools.length,
      tools,
      loaded: this.loaded.has(toolkit.name),
    }
  }

  private toolsForToolkit(name: CanonryMcpToolkitName): string[] {
    return this.entries
      .filter(entry => entry.tool.tier === name)
      .map(entry => entry.tool.name)
  }

  // RegisteredTool.enable/disable each call sendToolListChanged on the McpServer
  // we registered with. Loading an 11-tool toolkit emits 11 notifications under
  // that contract, which a spec-compliant client will treat as 11 catalog
  // refetches. Coalesce them into one notification per batch by intercepting
  // the SDK's sender for the duration of the batch.
  private batchListChanged(fn: () => void): void {
    const host = this.server as unknown as NotifierHost
    const original = host.sendToolListChanged
    let suppressed = false
    host.sendToolListChanged = () => {
      suppressed = true
    }
    try {
      fn()
    } finally {
      host.sendToolListChanged = original
    }
    if (suppressed) original.call(host)
  }
}
