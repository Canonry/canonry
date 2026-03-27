export type { WordpressConnectionRecord, WordpressRestPage, WordpressSiteContext } from './types.js'
export { WordpressApiError } from './types.js'
export {
  buildManualLlmsTxtUpdate,
  buildManualSchemaUpdate,
  buildManualStagingPush,
  createPage,
  diffPageAcrossEnvironments,
  getLlmsTxt,
  getPageBySlug,
  getPageDetail,
  getPageSchema,
  getSiteStatus,
  getWpStagingAdminUrl,
  listActivePlugins,
  listPages,
  parseEnv,
  resolveEnvironment,
  runAudit,
  setSeoMeta,
  updatePageBySlug,
  verifyWordpressConnection,
} from './wordpress-client.js'
