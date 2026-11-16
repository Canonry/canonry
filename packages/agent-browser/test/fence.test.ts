import { describe, expect, it } from 'vitest'
import { blockedPageHtml, decideFence, egressTarget } from '../src/index.js'

// The fence is what makes a check safe to run on a live site: no lead, analytics hit or ad
// conversion may leave the browser, and the agent must stay on the site under test.
const site = ['canonry.ai']
const request = (url: string, method = 'GET', isMainFrameDocument = false) => ({ url, method, isMainFrameDocument })

describe('decideFence', () => {
  it.each([
    ['a form post to the site', request('https://canonry.ai/api/agency-access', 'POST'), { action: 'answer-write' }],
    ['a write to www on the site', request('https://www.canonry.ai/leads', 'PUT'), { action: 'answer-write' }],
    ['a write to a subdomain', request('https://api.canonry.ai/leads', 'POST'), { action: 'answer-write' }],
    ['a write to another site', request('https://hooks.example.com/x', 'POST'), { action: 'drop', reason: 'offsite-write' }],
    ['an ad conversion beacon', request('https://bzr.openai.com/v1/sdk/events', 'POST'), { action: 'drop', reason: 'offsite-write' }],
    ['a write to a look-alike host', request('https://canonry.ai.evil.com/x', 'POST'), { action: 'drop', reason: 'offsite-write' }],
    ['a write to a host that only ends in the domain name', request('https://notcanonry.ai/x', 'POST'), { action: 'drop', reason: 'offsite-write' }],
    ['a tracker script', request('https://www.googletagmanager.com/gtm.js'), { action: 'drop', reason: 'tracker' }],
    ['another site opened in the page', request('https://github.com/Canonry', 'GET', true), { action: 'block-page' }],
    ['an asset from another site', request('https://fonts.gstatic.com/s/inter.woff2'), { action: 'continue' }],
    ['a page of the site', request('https://www.canonry.ai/blog', 'GET', true), { action: 'continue' }],
    ['a data URL', request('data:image/png;base64,AAAA'), { action: 'continue' }],
  ])('%s', (_label, req, want) => {
    expect(decideFence(req, site)).toEqual(want)
  })
})

// The host and port the egress policy is asked about before a request leaves the browser.
describe('egressTarget', () => {
  it.each([
    ['a page, its default https port', 'https://www.canonry.ai/blog?x=1#top', { host: 'www.canonry.ai', port: 443 }],
    ['plain http, its default port', 'http://canonry.ai/a', { host: 'canonry.ai', port: 80 }],
    ['a non-default port', 'http://canonry.ai:8080/a', { host: 'canonry.ai', port: 8080 }],
    ['a URL with credentials, which never reach the check', 'https://user:pass@canonry.ai/a', { host: 'canonry.ai', port: 443 }],
    ['an IPv6 literal, without brackets', 'http://[::1]:4100/', { host: '::1', port: 4100 }],
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/', { host: '169.254.169.254', port: 80 }],
    ['a data URL, which dials nothing', 'data:image/png;base64,AAAA', null],
    ['a blob URL', 'blob:https://canonry.ai/1234', null],
    ['text that is not a URL', 'nonsense', null],
  ])('%s', (_label, url, want) => {
    expect(egressTarget(url)).toEqual(want)
  })
})

describe('blockedPageHtml', () => {
  it('says why and escapes the URL a page tried to open', () => {
    const html = blockedPageHtml('https://evil.example/<script>"', 'This check opens only public web addresses.')
    expect(html).toContain('<p>This check opens only public web addresses. The page tried to open https://evil.example/&lt;script&gt;&quot;</p>')
    expect(html).not.toContain('<script>')
  })
})
