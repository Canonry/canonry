import type {
  WordpressAuditIssueDto,
  WordpressDiffDto,
  WordpressEnv,
  WordpressManualAssistDto,
  WordpressPageDetailDto,
  WordpressPageSummaryDto,
  WordpressSchemaBlockDto,
  WordpressSiteStatusDto,
  WordpressStatusDto,
} from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { CliError } from '../cli-error.js'

function getClient() {
  return createApiClient()
}

async function promptForAppPassword(): Promise<string> {
  const readline = await import('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })

  return new Promise<string>((resolve) => {
    rl.question('WordPress Application Password: ', (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function printSiteStatus(label: string, status: WordpressSiteStatusDto | null): void {
  if (!status) {
    console.log(`  ${label}: not configured`)
    return
  }

  console.log(`  ${label}: ${status.url}`)
  console.log(`    Reachable: ${status.reachable ? 'yes' : 'no'}`)
  console.log(`    WordPress: ${status.version ?? 'unknown'}`)
  console.log(`    Pages:     ${status.pageCount ?? 'unknown'}`)
  console.log(`    Plugins:   ${status.plugins?.length ? status.plugins.join(', ') : '(not visible)'}`)
  if (status.error) {
    console.log(`    Error:     ${status.error}`)
  }
}

function printWordpressStatus(project: string, status: WordpressStatusDto): void {
  if (!status.connected) {
    console.log(`No WordPress connection for project "${project}".`)
    console.log(`Run "canonry wordpress connect ${project} --url <url> --user <user>" to connect.`)
    return
  }

  console.log(`WordPress for "${project}":\n`)
  console.log(`  Default env: ${status.defaultEnv}`)
  printSiteStatus('Live', status.live)
  if (status.staging || status.defaultEnv === 'staging') {
    printSiteStatus('Staging', status.staging)
  }
  if (status.adminUrl) {
    console.log(`\n  WP STAGING admin: ${status.adminUrl}`)
  }
}

function printPages(project: string, env: WordpressEnv, pages: WordpressPageSummaryDto[]): void {
  if (pages.length === 0) {
    console.log(`No WordPress pages found for "${project}" (${env}).`)
    return
  }

  const slugWidth = Math.max(4, ...pages.map((page) => page.slug.length))
  const statusWidth = Math.max(6, ...pages.map((page) => page.status.length))
  console.log(`WordPress pages for "${project}" (${env}):\n`)
  console.log(`  ${'SLUG'.padEnd(slugWidth)}  ${'STATUS'.padEnd(statusWidth)}  MODIFIED`)
  console.log(`  ${'─'.repeat(slugWidth)}  ${'─'.repeat(statusWidth)}  ${'─'.repeat(20)}`)
  for (const page of pages) {
    console.log(`  ${page.slug.padEnd(slugWidth)}  ${page.status.padEnd(statusWidth)}  ${page.modifiedAt ?? '-'}`)
  }
}

function printSchemaBlocks(blocks: WordpressSchemaBlockDto[]): void {
  if (blocks.length === 0) {
    console.log('No JSON-LD schema blocks detected.')
    return
  }

  console.log(`Detected ${blocks.length} JSON-LD block(s):\n`)
  for (const [index, block] of blocks.entries()) {
    console.log(`  [${index + 1}] ${block.type}`)
    console.log(JSON.stringify(block.json, null, 2))
    if (index < blocks.length - 1) {
      console.log()
    }
  }
}

function printPageDetail(page: WordpressPageDetailDto): void {
  console.log(`Title:    ${page.title}`)
  console.log(`Slug:     ${page.slug}`)
  console.log(`Status:   ${page.status}`)
  console.log(`Env:      ${page.env}`)
  console.log(`Modified: ${page.modifiedAt ?? '-'}`)
  console.log(`Link:     ${page.link ?? '-'}`)
  console.log(`SEO title:       ${page.seo.title ?? '-'}`)
  console.log(`SEO description: ${page.seo.description ?? '-'}`)
  console.log(`Noindex:         ${page.seo.noindex == null ? '-' : page.seo.noindex ? 'yes' : 'no'}`)
  console.log(`Writable SEO:    ${page.seo.writable ? 'yes' : 'no'}`)
  console.log(`Schema blocks:   ${page.schemaBlocks.length}`)
  console.log('\nContent:\n')
  console.log(page.content)
}

function printManualAssist(label: string, payload: WordpressManualAssistDto): void {
  console.log(`${label} requires a manual step.\n`)
  console.log(`Target URL: ${payload.targetUrl}`)
  if (payload.adminUrl) {
    console.log(`Admin URL:  ${payload.adminUrl}`)
  }
  console.log(`\nContent:\n`)
  console.log(payload.content)
  if (payload.nextSteps.length > 0) {
    console.log('\nNext steps:')
    for (const step of payload.nextSteps) {
      console.log(`  - ${step}`)
    }
  }
}

function printAuditIssues(issues: WordpressAuditIssueDto[]): void {
  if (issues.length === 0) {
    console.log('No audit issues found.')
    return
  }

  for (const issue of issues) {
    console.log(`  [${issue.severity.toUpperCase()}] ${issue.slug}: ${issue.message}`)
  }
}

function printDiff(diff: WordpressDiffDto): void {
  const changed = Object.entries(diff.differences)
    .filter(([, value]) => value)
    .map(([key]) => key)

  console.log(`WordPress diff for "${diff.slug}":\n`)
  console.log(`  Has differences: ${diff.hasDifferences ? 'yes' : 'no'}`)
  console.log(`  Changed fields:  ${changed.length > 0 ? changed.join(', ') : 'none'}`)
  console.log(`\nLive:`)
  console.log(`  Title:        ${diff.live.title}`)
  console.log(`  Slug:         ${diff.live.slug}`)
  console.log(`  Content hash: ${diff.live.contentHash}`)
  console.log(`  SEO title:    ${diff.live.seo.title ?? '-'}`)
  console.log(`  Description:  ${diff.live.seo.description ?? '-'}`)
  console.log(`  Noindex:      ${diff.live.seo.noindex == null ? '-' : diff.live.seo.noindex ? 'yes' : 'no'}`)
  console.log(`  Schema:       ${diff.live.schemaBlocks.length} block(s)`)
  console.log(`  Snippet:      ${diff.live.contentSnippet || '(empty)'}`)
  console.log(`\nStaging:`)
  console.log(`  Title:        ${diff.staging.title}`)
  console.log(`  Slug:         ${diff.staging.slug}`)
  console.log(`  Content hash: ${diff.staging.contentHash}`)
  console.log(`  SEO title:    ${diff.staging.seo.title ?? '-'}`)
  console.log(`  Description:  ${diff.staging.seo.description ?? '-'}`)
  console.log(`  Noindex:      ${diff.staging.seo.noindex == null ? '-' : diff.staging.seo.noindex ? 'yes' : 'no'}`)
  console.log(`  Schema:       ${diff.staging.schemaBlocks.length} block(s)`)
  console.log(`  Snippet:      ${diff.staging.contentSnippet || '(empty)'}`)
}

export async function wordpressConnect(
  project: string,
  opts: {
    url: string
    user: string
    appPassword?: string
    stagingUrl?: string
    defaultEnv?: WordpressEnv
    format?: string
  },
): Promise<void> {
  const appPassword = opts.appPassword ?? await promptForAppPassword()
  if (!appPassword) {
    throw new CliError({
      code: 'WORDPRESS_APP_PASSWORD_REQUIRED',
      message: 'WordPress Application Password is required',
      displayMessage: 'Error: WordPress Application Password is required (pass --app-password or enter interactively).',
      details: { project },
    })
  }

  const client = getClient()
  const result = await client.wordpressConnect(project, {
    url: opts.url,
    stagingUrl: opts.stagingUrl,
    username: opts.user,
    appPassword,
    defaultEnv: opts.defaultEnv,
  })

  if (opts.format === 'json') {
    printJson(result)
    return
  }

  console.log(`WordPress connected for project "${project}".\n`)
  printWordpressStatus(project, result)
}

export async function wordpressDisconnect(project: string, format?: string): Promise<void> {
  const client = getClient()
  await client.wordpressDisconnect(project)

  if (format === 'json') {
    printJson({ project, disconnected: true })
    return
  }

  console.log(`WordPress disconnected from project "${project}".`)
}

export async function wordpressStatus(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.wordpressStatus(project)

  if (format === 'json') {
    printJson(result)
    return
  }

  printWordpressStatus(project, result)
}

export async function wordpressPages(project: string, opts: { env?: WordpressEnv; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.wordpressPages(project, opts.env)

  if (opts.format === 'json') {
    printJson(result)
    return
  }

  printPages(project, result.env, result.pages)
}

export async function wordpressPage(project: string, slug: string, opts: { env?: WordpressEnv; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.wordpressPage(project, slug, opts.env)

  if (opts.format === 'json') {
    printJson(result)
    return
  }

  printPageDetail(result)
}

export async function wordpressCreatePage(
  project: string,
  body: { title: string; slug: string; content: string; status?: string; env?: WordpressEnv; format?: string },
): Promise<void> {
  const client = getClient()
  const result = await client.wordpressCreatePage(project, body)

  if (body.format === 'json') {
    printJson(result)
    return
  }

  console.log(`Created WordPress page "${result.slug}" in ${result.env}.\n`)
  printPageDetail(result)
}

export async function wordpressUpdatePage(
  project: string,
  body: { currentSlug: string; title?: string; slug?: string; content?: string; status?: string; env?: WordpressEnv; format?: string },
): Promise<void> {
  const client = getClient()
  const result = await client.wordpressUpdatePage(project, body)

  if (body.format === 'json') {
    printJson(result)
    return
  }

  console.log(`Updated WordPress page "${body.currentSlug}" in ${result.env}.\n`)
  printPageDetail(result)
}

export async function wordpressSetMeta(
  project: string,
  body: { slug: string; title?: string; description?: string; noindex?: boolean; env?: WordpressEnv; format?: string },
): Promise<void> {
  const client = getClient()
  const result = await client.wordpressSetMeta(project, body)

  if (body.format === 'json') {
    printJson(result)
    return
  }

  console.log(`Updated SEO meta for "${body.slug}" in ${result.env}.\n`)
  printPageDetail(result)
}

export async function wordpressSchema(project: string, slug: string, opts: { env?: WordpressEnv; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.wordpressSchema(project, slug, opts.env)

  if (opts.format === 'json') {
    printJson(result)
    return
  }

  console.log(`Schema for "${slug}" (${result.env}):\n`)
  printSchemaBlocks(result.blocks)
}

export async function wordpressSetSchema(
  project: string,
  body: { slug: string; type?: string; json: string; env?: WordpressEnv; format?: string },
): Promise<void> {
  const client = getClient()
  const result = await client.wordpressSetSchema(project, body)

  if (body.format === 'json') {
    printJson(result)
    return
  }

  printManualAssist(`Schema update for "${body.slug}"`, result)
}

export async function wordpressLlmsTxt(project: string, opts: { env?: WordpressEnv; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.wordpressLlmsTxt(project, opts.env)

  if (opts.format === 'json') {
    printJson(result)
    return
  }

  console.log(`llms.txt for "${project}" (${result.env}): ${result.url}\n`)
  console.log(result.content ?? '(not found)')
}

export async function wordpressSetLlmsTxt(
  project: string,
  body: { content: string; env?: WordpressEnv; format?: string },
): Promise<void> {
  const client = getClient()
  const result = await client.wordpressSetLlmsTxt(project, body)

  if (body.format === 'json') {
    printJson(result)
    return
  }

  printManualAssist(`llms.txt update for "${project}"`, result)
}

export async function wordpressAudit(project: string, opts: { env?: WordpressEnv; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.wordpressAudit(project, opts.env)

  if (opts.format === 'json') {
    printJson(result)
    return
  }

  console.log(`WordPress audit for "${project}" (${result.env}):\n`)
  console.log(`  Pages scanned: ${result.pages.length}`)
  console.log(`  Issues found:  ${result.issues.length}\n`)
  printAuditIssues(result.issues)
}

export async function wordpressDiff(project: string, slug: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.wordpressDiff(project, slug)

  if (format === 'json') {
    printJson(result)
    return
  }

  printDiff(result)
}

export async function wordpressStagingStatus(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.wordpressStagingStatus(project)

  if (format === 'json') {
    printJson(result)
    return
  }

  console.log(`WordPress staging status for "${project}":\n`)
  console.log(`  Configured:        ${result.stagingConfigured ? 'yes' : 'no'}`)
  console.log(`  Staging URL:       ${result.stagingUrl ?? '-'}`)
  console.log(`  WP STAGING active: ${result.wpStagingActive ? 'yes' : 'no'}`)
  console.log(`  Admin URL:         ${result.adminUrl}`)
}

export async function wordpressStagingPush(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.wordpressStagingPush(project)

  if (format === 'json') {
    printJson(result)
    return
  }

  printManualAssist(`Staging push for "${project}"`, result)
}
