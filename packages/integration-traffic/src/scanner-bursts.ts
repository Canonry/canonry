import { AgentTrustLevels, AgentTrustReasons, type NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { classifyAiUserFetch, isSelfTraffic } from './classifier.js'

/** How near in time a probe must be to an agent request from the same client to mark it. */
export const SCANNER_BURST_WINDOW_MS = 10 * 60_000

/** A client's run of probes, each within the burst window of the next, in epoch milliseconds. */
export interface ScannerProbeWindow {
  firstProbeAt: number
  lastProbeAt: number
}

export interface FindScannerBurstsOptions {
  /** The client behind an IP address, or null to leave its requests alone. */
  clientKey: (remoteIp: string) => string | null
  /** Stored windows of earlier batches, loaded for the clients this batch names. */
  known?: (clients: readonly string[]) => ReadonlyMap<string, ScannerProbeWindow>
  windowMs?: number
}

export interface ScannerBursts {
  /** Agent requests, neither verified nor already likely fake, within the window of a probe from their client. */
  eventIds: Set<string>
  /** The latest probe window of each client that probed in this batch, where it changed. */
  windows: Map<string, ScannerProbeWindow>
}

function mergeRuns(runs: ScannerProbeWindow[], windowMs: number): ScannerProbeWindow[] {
  runs.sort((a, b) => a.firstProbeAt - b.firstProbeAt)
  const merged: ScannerProbeWindow[] = []
  for (const run of runs) {
    const last = merged.at(-1)
    if (last && run.firstProbeAt <= last.lastProbeAt + windowMs) last.lastProbeAt = Math.max(last.lastProbeAt, run.lastProbeAt)
    else merged.push({ ...run })
  }
  return merged
}

/**
 * Agent requests sent by a scanner. A client (one IP address) that asked for
 * a scanner path while claiming an AI agent did not send its other agent
 * requests for a person either, so every unverified agent request it sent
 * within `windowMs` of a probe is marked. Stored windows (`known`) let a burst
 * split across batches, or pushed one request at a time, read the same way.
 * A request that arrived in an earlier batch, before the client's first
 * probe, is not revisited. Verified requests are never marked or used as
 * probes: their IP belongs to the operator, so a person asked for them.
 */
export function findScannerBursts(events: readonly NormalizedTrafficRequest[], options: FindScannerBurstsOptions): ScannerBursts {
  const windowMs = options.windowMs ?? SCANNER_BURST_WINDOW_MS
  const keys = new Map<string, string | null>()
  const probesByClient = new Map<string, number[]>()
  const candidates: Array<{ eventId: string, client: string, at: number }> = []
  for (const event of events) {
    const remoteIp = event.remoteIp?.trim()
    if (!remoteIp || isSelfTraffic(event)) continue
    const agent = classifyAiUserFetch(event)
    if (!agent || agent.trust === AgentTrustLevels.verified) continue
    const at = Date.parse(event.observedAt)
    if (!Number.isFinite(at)) continue
    let client = keys.get(remoteIp)
    if (client === undefined) {
      client = options.clientKey(remoteIp)
      keys.set(remoteIp, client)
    }
    if (client === null) continue
    if (agent.trustReasons.includes(AgentTrustReasons['scanner-path'])) {
      const probes = probesByClient.get(client)
      if (probes) probes.push(at)
      else probesByClient.set(client, [at])
    } else if (agent.trust !== AgentTrustLevels.likely_fake) {
      candidates.push({ eventId: event.eventId, client, at })
    }
  }

  const clients = [...new Set([...probesByClient.keys(), ...candidates.map(candidate => candidate.client)])]
  const known = clients.length > 0 && options.known ? options.known(clients) : new Map<string, ScannerProbeWindow>()
  const runsByClient = new Map<string, ScannerProbeWindow[]>()
  const windows = new Map<string, ScannerProbeWindow>()
  for (const client of clients) {
    const stored = known.get(client)
    const probes = probesByClient.get(client) ?? []
    const runs = mergeRuns([...(stored ? [stored] : []), ...probes.map(at => ({ firstProbeAt: at, lastProbeAt: at }))], windowMs)
    if (runs.length === 0) continue
    runsByClient.set(client, runs)
    // Runs are sorted and apart, so the last one is the latest.
    const latest = runs.at(-1)!
    if (probes.length > 0 && (latest.firstProbeAt !== stored?.firstProbeAt || latest.lastProbeAt !== stored.lastProbeAt)) windows.set(client, latest)
  }

  const eventIds = new Set<string>()
  for (const candidate of candidates) {
    const runs = runsByClient.get(candidate.client)
    if (runs?.some(run => candidate.at >= run.firstProbeAt - windowMs && candidate.at <= run.lastProbeAt + windowMs)) eventIds.add(candidate.eventId)
  }
  return { eventIds, windows }
}

/** Bursts within one batch, keyed by raw IP and never stored. */
export function findScannerBurstsInBatch(events: readonly NormalizedTrafficRequest[]): Set<string> {
  return findScannerBursts(events, { clientKey: remoteIp => remoteIp }).eventIds
}
