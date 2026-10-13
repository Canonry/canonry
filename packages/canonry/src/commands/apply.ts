import fs from 'node:fs'
import { parseAllDocuments } from 'yaml'
import type { ProjectConfig } from '@ainyc/canonry-contracts'
import { createApiClient, type ApplyPreviewDto, type ApplyResultDto } from '../client.js'
import { CliError, isEndpointMissing, isMachineFormat } from '../cli-error.js'
import { describeError } from '@ainyc/canonry-contracts'



export type ApplyFileResult = {
  filePath: string
  applied: ApplyResultDto[]
  errors: string[]
}

export type ApplySummary = {
  files: ApplyFileResult[]
  appliedCount: number
  errorCount: number
}

export type ApplyPreviewFileResult = {
  filePath: string
  previews: ApplyPreviewDto[]
  errors: string[]
}

export type ApplyDryRunSummary = {
  dryRun: true
  files: ApplyPreviewFileResult[]
  changedCount: number
  errorCount: number
}

function previewValue(value: unknown): string {
  const encoded = JSON.stringify(value)
  return encoded === undefined ? String(value) : encoded
}

function describeApplyError(error: unknown): string {
  const message = describeError(error)
  const details = error instanceof CliError ? error.details : undefined
  const issues = Array.isArray(details?.issues) ? details.issues : []
  const formatted = issues.flatMap(issue => {
    if (!issue || typeof issue !== 'object') return []
    const record = issue as { path?: unknown; message?: unknown }
    const path = Array.isArray(record.path) ? record.path.join('.') : typeof record.path === 'string' ? record.path : ''
    const issueMessage = typeof record.message === 'string' ? record.message : ''
    return path && issueMessage ? [`${path}: ${issueMessage}`] : []
  })
  return formatted.length > 0 ? `${message} (${formatted.join('; ')})` : message
}

export async function applyConfigFile(filePath: string, options: { dryRun?: boolean } = {}): Promise<ApplyFileResult | ApplyPreviewFileResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const docs = parseAllDocuments(content)

  const client = createApiClient()

  const errors: string[] = []
  const applied: ApplyResultDto[] = []
  const previews: ApplyPreviewDto[] = []
  const dryRun = options.dryRun === true

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!
    if (doc.errors.length > 0) {
      errors.push(`Document ${i + 1}: YAML parse error - ${doc.errors[0]?.message}`)
      continue
    }

    const config = doc.toJSON() as ProjectConfig
    if (!config || typeof config !== 'object') continue

    try {
      if (dryRun) previews.push(await client.previewApply(config))
      else applied.push(await client.apply(config))
    } catch (err) {
      if (dryRun && isEndpointMissing(err)) {
        throw new CliError({
          code: 'APPLY_PREVIEW_UNSUPPORTED',
          message: 'The connected server does not support apply preview.',
          displayMessage: 'Apply preview is unavailable on the connected server. Upgrade the server or remove --dry-run.',
          details: { filePath },
        })
      }
      const msg = describeApplyError(err)
      errors.push(`Document ${i + 1}: ${msg}`)
    }
  }

  return dryRun ? { filePath, previews, errors } : { filePath, applied, errors }
}

export async function applyConfigs(filePaths: string[], format?: string, options: { dryRun?: boolean } = {}): Promise<void> {
  if (options.dryRun) {
    const files: ApplyPreviewFileResult[] = []
    for (const filePath of filePaths) {
      let result: ApplyPreviewFileResult
      try {
        result = await applyConfigFile(filePath, { dryRun: true }) as ApplyPreviewFileResult
      } catch (err) {
        if (err instanceof CliError && err.code === 'APPLY_PREVIEW_UNSUPPORTED') throw err
        result = { filePath, previews: [], errors: [describeApplyError(err)] }
      }
      files.push(result)
      if (!isMachineFormat(format)) {
        console.log(`\n${filePath}`)
        for (const preview of result.previews) {
          console.log(`${preview.action} ${preview.project.name}: ${preview.changed ? 'changes detected' : 'no changes'}`)
          for (const [field, change] of Object.entries(preview.fields)) {
            console.log(`  ~ ${field}: ${previewValue(change.before)} -> ${previewValue(change.after)}`)
          }
          if (!preview.queries.managed) console.log('  queries: not managed by this file')
          else {
            for (const query of preview.queries.added) console.log(`  + query: ${query}`)
            for (const query of preview.queries.removed) console.log(`  - query: ${query}`)
            console.log(`  queries: +${preview.queries.added.length} -${preview.queries.removed.length}`)
          }
          if (!preview.competitors.managed) console.log('  competitors: not managed by this file')
          else {
            for (const domain of preview.competitors.added) console.log(`  + competitor: ${domain}`)
            for (const domain of preview.competitors.removed) console.log(`  - competitor: ${domain}`)
            for (const change of preview.competitors.aliasChanges) console.log(`  ~ competitor aliases ${change.domain}: ${previewValue(change.before)} -> ${previewValue(change.after)}`)
            for (const dropped of preview.competitors.droppedAliases) console.log(`  - dropped alias: ${dropped.domain} ${dropped.alias} (${dropped.reason})`)
            console.log(`  competitors: +${preview.competitors.added.length} -${preview.competitors.removed.length}`)
          }
          if (!preview.schedule.managed) console.log('  schedule: not managed by this file')
          else console.log(`  schedule: ${preview.schedule.action}`)
          if (!preview.notifications.managed) console.log('  notifications: not managed by this file')
          else {
            for (const notification of preview.notifications.added) console.log(`  + notification: ${notification.urlHost} (${notification.events.join(', ')})`)
            for (const notification of preview.notifications.removed) console.log(`  - notification: ${notification.urlHost} (${notification.events.join(', ')})`)
            for (const notification of preview.notifications.kept) {
              const urlChange = notification.urlChanged ? ' (URL changed)' : ''
              console.log(`  ~ notification ${notification.urlHost}${urlChange}: ${notification.eventsBefore.join(', ')} -> ${notification.eventsAfter.join(', ')}`)
            }
            console.log(`  notifications: +${preview.notifications.added.length} -${preview.notifications.removed.length}`)
          }
        }
      }
    }
    const summary: ApplyDryRunSummary = {
      dryRun: true,
      files,
      changedCount: files.reduce((count, file) => count + file.previews.filter(preview => preview.changed).length, 0),
      errorCount: files.reduce((count, file) => count + file.errors.length, 0),
    }
    if (isMachineFormat(format)) console.log(JSON.stringify(summary, null, 2))
    else if (summary.errorCount === 0) console.log('No DB writes performed. Re-run without --dry-run to apply.')
    if (summary.errorCount > 0) {
      throw new CliError({ code: 'APPLY_FAILED', message: `${summary.errorCount} document(s) failed during apply`, displayMessage: files.flatMap(file => file.errors).join('\n'), details: summary })
    }
    return
  }

  const files: ApplyFileResult[] = []

  for (const filePath of filePaths) {
    let result: ApplyFileResult
    try {
      result = await applyConfigFile(filePath) as ApplyFileResult
    } catch (err) {
      const message = describeApplyError(err)
      result = {
        filePath,
        applied: [],
        errors: [message],
      }
    }
    files.push(result)

    if (!isMachineFormat(format)) {
      for (const applied of result.applied) {
        console.log(`Applied config for "${applied.name}" (revision ${applied.configRevision})`)
      }
    }
  }

  const summary: ApplySummary = {
    files,
    appliedCount: files.reduce((count, file) => count + file.applied.length, 0),
    errorCount: files.reduce((count, file) => count + file.errors.length, 0),
  }

  if (summary.errorCount > 0) {
    throw new CliError({
      code: 'APPLY_FAILED',
      message: `${summary.errorCount} document(s) failed during apply`,
      displayMessage: files.flatMap(file => file.errors).join('\n'),
      details: summary,
    })
  }

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(summary, null, 2))
  }
}
