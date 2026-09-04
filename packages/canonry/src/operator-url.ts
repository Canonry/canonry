/** Convert a bind-only wildcard into a loopback host an operator can open. */
export function operatorHost(bindHost: string): string {
  if (bindHost === '0.0.0.0') return '127.0.0.1'
  // The IPv6 wildcard is the same idea as 0.0.0.0 and needs the same treatment.
  if (bindHost === '::' || bindHost === '[::]') return '::1'
  return bindHost
}

/**
 * A literal IPv6 host MUST be bracketed inside a URL authority, or its colons
 * read as the port separator: `--host ::1` produced `http://::1:4100` and the
 * wildcard produced `http://:::4100`. The daemon's readiness probe fetches this
 * exact string for /health, so an unbracketed host made `canonry start` report a
 * failed daemon for a server that was up and serving.
 */
export function operatorHttpUrl(bindHost: string, port: string | number): string {
  const host = operatorHost(bindHost)
  const bare = host.replace(/^\[|\]$/g, '')
  return `http://${bare.includes(':') ? `[${bare}]` : bare}:${port}`
}
