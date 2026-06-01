import os from 'node:os'
import path from 'node:path'

export const CC_BASE_URL = 'https://data.commoncrawl.org/projects/hyperlinkgraph'

export const PLUGIN_DIR = path.join(os.homedir(), '.canonry', 'plugins')
export const PLUGIN_PKG_JSON = path.join(PLUGIN_DIR, 'package.json')

export const DUCKDB_SPEC = process.env.CANONRY_DUCKDB_SPEC ?? '@duckdb/node-api@1.4.4-r.3'

export const CC_CACHE_DIR = process.env.CANONRY_CC_CACHE_DIR
  ?? path.join(os.homedir(), '.canonry', 'cache', 'commoncrawl')

const CC_MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)'
/**
 * Common Crawl publishes the hyperlink graph as rolling, monthly-stepped,
 * overlapping 3-month windows (`cc-main-YYYY-<mon>-<mon>-<mon>`), named by the
 * window's FIRST month's year. This validates the slug SHAPE only — a
 * well-formed-but-unpublished window (e.g. a cross-year `nov-dec-jan`) 404s at
 * probe/download time, which is the authoritative existence check. Group 1 is
 * the year, group 2 is the full `mon-mon-mon` window slug.
 */
export const RELEASE_ID_REGEX = new RegExp(`^cc-main-(\\d{4})-(${CC_MONTH}-${CC_MONTH}-${CC_MONTH})$`)

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
