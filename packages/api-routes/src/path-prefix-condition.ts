import { or, sql, type SQL } from 'drizzle-orm'
import { escapeLikePattern } from '@ainyc/canonry-contracts'

/** Match the path itself or descendants, treating SQL wildcard characters literally. */
export function literalPathPrefixCondition(path: SQL, prefix: string): SQL {
  return or(sql`${path} = ${prefix}`, sql`${path} LIKE ${escapeLikePattern(prefix) + '/%'} ESCAPE '\\'`)!
}
