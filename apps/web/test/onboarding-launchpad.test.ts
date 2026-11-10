import { describe, expect, it } from 'vitest'

import { deriveLaunchpadIdentity } from '../src/pages/OnboardingSetupPage.js'

describe('setup website form', () => {
  it('derives editable project defaults from a public domain without making locale a gate', () => {
    expect(deriveLaunchpadIdentity('https://www.Example.co.uk/pricing?ref=home')).toEqual({
      canonicalDomain: 'example.co.uk',
      projectName: 'example-co-uk',
      displayName: 'Example',
    })
  })

  it('keeps an invalid domain out of a create request', () => {
    expect(deriveLaunchpadIdentity('not a domain')).toBeNull()
  })

  it('keeps IPv4, IPv6, and private literal hosts out of a public-site crawl request', () => {
    expect(deriveLaunchpadIdentity('127.0.0.1')).toBeNull()
    expect(deriveLaunchpadIdentity('192.168.1.10')).toBeNull()
    expect(deriveLaunchpadIdentity('http://[::1]')).toBeNull()
  })

  it('accepts inferred HTTPS for a bare domain but rejects explicit non-web schemes', () => {
    expect(deriveLaunchpadIdentity('example.com')).not.toBeNull()
    expect(deriveLaunchpadIdentity('ftp://example.com')).toBeNull()
  })
})
