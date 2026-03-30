export type { WordpressConnectionRecord, WordpressRestPage, WordpressSiteContext } from './types.js'
export { WordpressApiError } from './types.js'
export type { BulkMetaEntry, SeoWriteStrategy } from './wordpress-client.js'
export type {
  BusinessAddress,
  BusinessProfile,
  FaqEntry,
  SchemaPageEntry,
  SchemaProfileFile,
} from './schema-templates.js'
export {
  generateSchema,
  isSupportedSchemaType,
  parseSchemaPageEntry,
  supportedSchemaTypes,
} from './schema-templates.js'
export {
  buildManualLlmsTxtUpdate,
  buildManualSchemaUpdate,
  buildManualStagingPush,
  bulkSetSeoMeta,
  createPage,
  deploySchema,
  deploySchemaFromProfile,
  detectSeoWriteStrategy,
  diffPageAcrossEnvironments,
  getLlmsTxt,
  getPageBySlug,
  getPageDetail,
  getPageSchema,
  getSchemaStatus,
  getSiteStatus,
  getWpStagingAdminUrl,
  injectCanonrySchema,
  listActivePlugins,
  listPages,
  parseEnv,
  resolveEnvironment,
  runAudit,
  setSeoMeta,
  stripCanonrySchema,
  updatePageBySlug,
  verifyWordpressConnection,
} from './wordpress-client.js'
