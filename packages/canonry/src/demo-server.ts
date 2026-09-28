import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, migrate } from '@ainyc/canonry-db'
import { buildDemoAeroPreviews } from './demo/aero-preview.js'
import { createDemoHttpServer } from './demo/http.js'
import { seedDemoMarketing } from './demo/seed-marketing.js'
import { seedDemoExploration } from './demo/seed-exploration.js'
import { seedDemoCore } from './demo/seed-core.js'
import { seedDemoSignals } from './demo/seed-signals.js'
import { demoReadOptions } from './demo/stores.js'
import { createDemoSeedContext } from './demo/types.js'

/** Always creates a fresh in-memory sample. There is no database/config path option. */
export async function createDemoServer(options: { assetsDir?: string; now?: Date; trustProxy?: readonly string[] } = {}) {
  const db = createClient(':memory:')
  try {
    migrate(db)
    const context = createDemoSeedContext(options.now)
    seedDemoCore(db, context)
    await seedDemoSignals(db, context)
    seedDemoExploration(db, context)
    seedDemoMarketing(db, context)
    // Scripted Aero turns, read from the rows just seeded. A seed change that
    // breaks a turn fails startup here instead of serving contradicting numbers.
    const aeroPreviews = buildDemoAeroPreviews(db, context)
    const app = await createDemoHttpServer({
      db, now: context.now, trustProxy: options.trustProxy,
      assetsDir: options.assetsDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'assets'),
      readOptions: demoReadOptions(db, context),
      aeroPreviews,
    })
    db.$client.pragma('query_only = ON')
    app.addHook('onClose', async () => { db.$client.close() })
    return app
  } catch (error) {
    db.$client.close()
    throw error
  }
}
