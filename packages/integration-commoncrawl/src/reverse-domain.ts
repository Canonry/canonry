export function reverseDomain(domain: string): string {
  return domain.split('.').reverse().join('.')
}

export function forwardDomain(revDomain: string): string {
  return revDomain.split('.').reverse().join('.')
}
