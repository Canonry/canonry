import crypto from 'node:crypto'
import fs from 'node:fs'
import readline from 'node:readline'
import { getConfigDir, getConfigPath, configExists, saveConfig } from '../config.js'
import { createClient, migrate } from '@ainyc/aeo-platform-db'
import { apiKeys } from '@ainyc/aeo-platform-db'
import path from 'node:path'

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

export async function initCommand(): Promise<void> {
  console.log('Initializing canonry...\n')

  if (configExists()) {
    console.log(`Config already exists at ${getConfigPath()}`)
    console.log('To reinitialize, delete the config file first.')
    return
  }

  // Create config directory
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }

  // Prompt for Gemini API key
  const geminiApiKey = await prompt('Enter your Gemini API key: ')
  if (!geminiApiKey) {
    console.error('Gemini API key is required')
    process.exit(1)
  }

  // Prompt for Gemini model (with default)
  const geminiModel = await prompt('Gemini model [gemini-2.5-flash]: ') || 'gemini-2.5-flash'

  // Generate random API key for the local server
  const rawApiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  const keyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex')
  const keyPrefix = rawApiKey.slice(0, 9)

  // Database path
  const databasePath = path.join(configDir, 'data.db')

  // Create and migrate database
  const db = createClient(databasePath)
  migrate(db)

  // Insert the API key
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'default',
    keyHash,
    keyPrefix,
    scopes: '["*"]',
    createdAt: new Date().toISOString(),
  }).run()

  // Save config
  saveConfig({
    apiUrl: 'http://localhost:4100',
    database: databasePath,
    apiKey: rawApiKey,
    geminiApiKey,
    geminiModel,
    geminiQuota: {
      maxConcurrency: 2,
      maxRequestsPerMinute: 10,
      maxRequestsPerDay: 500,
    },
  })

  console.log(`\nConfig saved to ${getConfigPath()}`)
  console.log(`Database created at ${databasePath}`)
  console.log(`API key: ${rawApiKey}`)
  console.log('\nRun "canonry serve" to start the server.')
}
