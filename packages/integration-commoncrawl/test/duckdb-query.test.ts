import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { queryBacklinks } from '../src/duckdb-query.js'
import { reverseDomain } from '../src/reverse-domain.js'

let duckdb: unknown
let tmpDir: string
let vertexPath: string
let edgesPath: string

const vertices: { id: number; domain: string; numHosts: number }[] = [
  { id: 1, domain: 'roots.io', numHosts: 5 },
  { id: 2, domain: 'laravel.com', numHosts: 10 },
  { id: 3, domain: 'github.com', numHosts: 20000 },
  { id: 4, domain: 'reddit.com', numHosts: 8000 },
  { id: 5, domain: 'wordpress.org', numHosts: 12000 },
  { id: 6, domain: 'stackoverflow.com', numHosts: 15000 },
  { id: 7, domain: 'medium.com', numHosts: 7000 },
  { id: 8, domain: 'unused.example', numHosts: 1 },
]

const edges: { fromId: number; toId: number }[] = [
  { fromId: 3, toId: 1 },
  { fromId: 4, toId: 1 },
  { fromId: 5, toId: 1 },
  { fromId: 6, toId: 2 },
  { fromId: 7, toId: 2 },
  { fromId: 3, toId: 2 },
  { fromId: 8, toId: 8 },
]

function verticesTsv(): string {
  return vertices
    .map((v) => `${v.id}\t${reverseDomain(v.domain)}\t${v.numHosts}`)
    .join('\n') + '\n'
}

function edgesTsv(): string {
  return edges.map((e) => `${e.fromId}\t${e.toId}`).join('\n') + '\n'
}

beforeAll(async () => {
  duckdb = await import('@duckdb/node-api')
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-duckdb-'))
  vertexPath = path.join(tmpDir, 'vertices.txt.gz')
  edgesPath = path.join(tmpDir, 'edges.txt.gz')
  await fs.writeFile(vertexPath, gzipSync(Buffer.from(verticesTsv(), 'utf8')))
  await fs.writeFile(edgesPath, gzipSync(Buffer.from(edgesTsv(), 'utf8')))
})

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('queryBacklinks', () => {
  test('returns forward-domain rows for a single target, sorted by num_hosts DESC', async () => {
    const rows = await queryBacklinks({
      vertexPath,
      edgesPath,
      targets: ['roots.io'],
      duckdb,
    })
    expect(rows).toEqual([
      { targetDomain: 'roots.io', linkingDomain: 'github.com', numHosts: 20000 },
      { targetDomain: 'roots.io', linkingDomain: 'wordpress.org', numHosts: 12000 },
      { targetDomain: 'roots.io', linkingDomain: 'reddit.com', numHosts: 8000 },
    ])
  })

  test('covers multiple targets in a single pass', async () => {
    const rows = await queryBacklinks({
      vertexPath,
      edgesPath,
      targets: ['roots.io', 'laravel.com'],
      duckdb,
    })
    const byTarget = new Map<string, { linkingDomain: string; numHosts: number }[]>()
    for (const r of rows) {
      const bucket = byTarget.get(r.targetDomain) ?? []
      bucket.push({ linkingDomain: r.linkingDomain, numHosts: r.numHosts })
      byTarget.set(r.targetDomain, bucket)
    }
    expect(byTarget.get('roots.io')).toEqual([
      { linkingDomain: 'github.com', numHosts: 20000 },
      { linkingDomain: 'wordpress.org', numHosts: 12000 },
      { linkingDomain: 'reddit.com', numHosts: 8000 },
    ])
    expect(byTarget.get('laravel.com')).toEqual([
      { linkingDomain: 'github.com', numHosts: 20000 },
      { linkingDomain: 'stackoverflow.com', numHosts: 15000 },
      { linkingDomain: 'medium.com', numHosts: 7000 },
    ])
  })

  test('applies limitPerTarget using a window function', async () => {
    const rows = await queryBacklinks({
      vertexPath,
      edgesPath,
      targets: ['roots.io', 'laravel.com'],
      limitPerTarget: 1,
      duckdb,
    })
    expect(rows).toEqual([
      { targetDomain: 'laravel.com', linkingDomain: 'github.com', numHosts: 20000 },
      { targetDomain: 'roots.io', linkingDomain: 'github.com', numHosts: 20000 },
    ])
  })

  test('returns empty array for unknown targets', async () => {
    const rows = await queryBacklinks({
      vertexPath,
      edgesPath,
      targets: ['nope.example'],
      duckdb,
    })
    expect(rows).toEqual([])
  })

  test('short-circuits on empty target list without touching duckdb', async () => {
    const rows = await queryBacklinks({
      vertexPath,
      edgesPath,
      targets: [],
      duckdb: null,
    })
    expect(rows).toEqual([])
  })
})
