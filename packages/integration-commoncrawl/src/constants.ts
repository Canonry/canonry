import os from 'node:os'
import path from 'node:path'

export const CC_BASE_URL = 'https://data.commoncrawl.org/projects/hyperlinkgraph'

export const PLUGIN_DIR = path.join(os.homedir(), '.canonry', 'plugins')
export const PLUGIN_PKG_JSON = path.join(PLUGIN_DIR, 'package.json')

export const DUCKDB_SPEC = process.env.CANONRY_DUCKDB_SPEC ?? '@duckdb/node-api@1.4.4-r.3'

export const CC_CACHE_DIR = process.env.CANONRY_CC_CACHE_DIR
  ?? path.join(os.homedir(), '.canonry', 'cache', 'commoncrawl')

export const RELEASE_ID_REGEX = /^cc-main-(\d{4})-(jan-feb-mar|apr-may-jun|jul-aug-sep|oct-nov-dec)$/

export interface ReleasePaths {
  vertexUrl: string
  edgesUrl: string
  vertexFilename: string
  edgesFilename: string
}

export function ccReleasePaths(release: string): ReleasePaths {
  const base = `${CC_BASE_URL}/${release}/domain`
  const vertexFilename = `${release}-domain-vertices.txt.gz`
  const edgesFilename = `${release}-domain-edges.txt.gz`
  return {
    vertexUrl: `${base}/${vertexFilename}`,
    edgesUrl: `${base}/${edgesFilename}`,
    vertexFilename,
    edgesFilename,
  }
}
