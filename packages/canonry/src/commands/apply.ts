import fs from 'node:fs'
import { parseAllDocuments } from 'yaml'
import { createApiClient, type ApplyResultDto } from '../client.js'
import { CliError } from '../cli-error.js'



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

export async function applyConfig(filePath: string): Promise<void> {
  const result = await applyConfigFile(filePath)

  for (const applied of result.applied) {
    console.log(`Applied config for "${applied.name}" (revision ${applied.configRevision})`)
  }

  if (result.errors.length > 0) {
    throw new Error(`${result.errors.length} document(s) failed in ${filePath}:\n${result.errors.map(e => `  - ${e}`).join('\n')}`)
  }
}

export async function applyConfigFile(filePath: string): Promise<ApplyFileResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const docs = parseAllDocuments(content)

  const client = createApiClient()

  const errors: string[] = []
  const applied: ApplyResultDto[] = []

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!
    if (doc.errors.length > 0) {
      errors.push(`Document ${i + 1}: YAML parse error — ${doc.errors[0]?.message}`)
      continue
    }

    const config = doc.toJSON() as object
    if (!config || typeof config !== 'object') continue

    try {
      const result = await client.apply(config)
      applied.push(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`Document ${i + 1}: ${msg}`)
    }
  }

  return { filePath, applied, errors }
}

export async function applyConfigs(filePaths: string[], format?: string): Promise<void> {
  const files: ApplyFileResult[] = []

  for (const filePath of filePaths) {
    let result: ApplyFileResult
    try {
      result = await applyConfigFile(filePath)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result = {
        filePath,
        applied: [],
        errors: [message],
      }
    }
    files.push(result)

    if (format !== 'json') {
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

  if (format === 'json') {
    console.log(JSON.stringify(summary, null, 2))
  }
}
