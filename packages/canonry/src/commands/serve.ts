import { loadConfig } from '../config.js'
import { createClient, migrate } from '@ainyc/aeo-platform-db'
import { createServer } from '../server.js'

export async function serveCommand(): Promise<void> {
  const config = loadConfig()
  const port = parseInt(process.env.CANONRY_PORT ?? '4100', 10)

  // Create DB client and run migrations
  const db = createClient(config.database)
  migrate(db)

  // Create and start server
  const app = await createServer({ config, db })

  try {
    await app.listen({ host: '0.0.0.0', port })
    console.log(`\nCanonry server running at http://localhost:${port}`)
    console.log('Press Ctrl+C to stop.\n')
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}
