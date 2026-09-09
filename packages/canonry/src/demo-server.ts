import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, migrate } from '@ainyc/canonry-db'
import { createDemoHttpServer } from './demo/http.js'
import { seedDemoMarketing } from './demo/seed-marketing.js'
import { seedDemoExploration } from './demo/seed-exploration.js'
import { seedDemoCore } from './demo/seed-core.js'
import { seedDemoSignals } from './demo/seed-signals.js'
import { demoReadOptions } from './demo/stores.js'
import { createDemoSeedContext } from './demo/types.js'

/** Always creates a fresh in-memory sample. There is no database/config path option. */
export async function createDemoServer(options: { assetsDir?: string; now?: Date } = {}) {
  const db = createClient(':memory:')
  try {
    migrate(db)
    const context = createDemoSeedContext(options.now)
    seedDemoCore(db, context)
    seedDemoSignals(db, context)
    seedDemoExploration(db, context)
    seedDemoMarketing(db, context)
    const app = await createDemoHttpServer({
      db, now: context.now,
      assetsDir: options.assetsDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'assets'),
      readOptions: demoReadOptions(db, context),
    })
    db.$client.pragma('query_only = ON')
    app.addHook('onClose', async () => { db.$client.close() })
    return app
  } catch (error) {
    db.$client.close()
    throw error
  }
}
