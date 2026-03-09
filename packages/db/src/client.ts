export interface DatabaseClientPlaceholder {
  kind: 'database-client-placeholder'
  status: 'unconfigured'
}

export function createDatabaseClientPlaceholder(): DatabaseClientPlaceholder {
  return {
    kind: 'database-client-placeholder',
    status: 'unconfigured',
  }
}
