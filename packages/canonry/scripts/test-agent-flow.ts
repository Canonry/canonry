#!/usr/bin/env tsx
/**
 * Manual integration test: runs detection + status against real OpenClaw.
 * Usage: cd packages/canonry && npx tsx scripts/test-agent-flow.ts
 */
import os from 'node:os'
import path from 'node:path'
import { detectOpenClaw, getAeroStateDir } from '../src/agent-bootstrap.js'
import { AgentManager } from '../src/agent-manager.js'

async function main() {
  // 1. Detection
  console.log('=== Detection ===')
  const result = await detectOpenClaw()
  console.log(JSON.stringify(result, null, 2))

  if (!result.found) {
    console.log('\nOpenClaw not installed. Run: npm install -g openclaw')
    process.exit(1)
  }

  // 2. Status check (against real aero state dir)
  const stateDir = getAeroStateDir()
  console.log(`\n=== Status (${stateDir}) ===`)
  const mgr = new AgentManager({ profile: 'aero', gatewayPort: 3579, binary: result.path }, stateDir)
  const status = mgr.status()
  console.log(JSON.stringify(status, null, 2))

  // 3. If you want to test the full lifecycle, uncomment:
  // console.log('\n=== Starting gateway ===')
  // await mgr.start()
  // console.log(mgr.status())
  //
  // console.log('\n=== Stopping gateway ===')
  // await mgr.stop()
  // console.log(mgr.status())
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
