import { describe, expect, it } from 'vitest'
import { hasVerificationDataFor, ipInCidr, parseCidr, parseIp, verifyIpForRule } from '../src/index.js'

describe('parseIp', () => {
  it('parses IPv4 to a 32-bit BigInt', () => {
    expect(parseIp('1.2.3.4')).toEqual({ version: 4, addr: BigInt(0x01020304) })
    expect(parseIp('0.0.0.0')).toEqual({ version: 4, addr: 0n })
    expect(parseIp('255.255.255.255')).toEqual({ version: 4, addr: BigInt(0xffffffff) })
  })

  it('rejects malformed IPv4', () => {
    expect(parseIp('1.2.3')).toBeNull()
    expect(parseIp('1.2.3.4.5')).toBeNull()
    expect(parseIp('1.2.3.256')).toBeNull()
    expect(parseIp('1.2.3.-1')).toBeNull()
    expect(parseIp('a.b.c.d')).toBeNull()
    expect(parseIp('')).toBeNull()
  })

  it('parses full IPv6', () => {
    const parsed = parseIp('2001:db8::1')
    expect(parsed?.version).toBe(6)
    expect(parsed?.addr).toBe(0x20010db8000000000000000000000001n)
  })

  it('handles IPv6 :: zero-compression', () => {
    expect(parseIp('::')?.addr).toBe(0n)
    expect(parseIp('::1')?.addr).toBe(1n)
    // `ff::` is the address with `ff` in the FIRST 16-bit group and
    // zeros everywhere else, i.e. 0xff << 112 in the 128-bit address.
    expect(parseIp('ff::')?.addr).toBe(0xffn << 112n)
  })

  it('handles IPv4-mapped IPv6 (::ffff:1.2.3.4)', () => {
    // Common when an IPv6-only edge forwards an IPv4 client — the
    // ::ffff: prefix is stripped and the address is treated as IPv4
    // so CIDR matches on either family work.
    const parsed = parseIp('::ffff:1.2.3.4')
    expect(parsed).toEqual({ version: 4, addr: BigInt(0x01020304) })
  })

  it('rejects malformed IPv6', () => {
    expect(parseIp('1::2::3')).toBeNull()  // two zero-compressions
    expect(parseIp('xyz::1')).toBeNull()
    expect(parseIp(':::')).toBeNull()       // three colons
  })
})

describe('parseCidr', () => {
  it('parses IPv4 CIDR and computes the mask correctly', () => {
    const cidr = parseCidr('1.2.3.0/24')
    expect(cidr).not.toBeNull()
    expect(cidr!.version).toBe(4)
    expect(cidr!.network).toBe(BigInt(0x01020300))
    // /24 mask = 0xffffff00
    expect(cidr!.mask).toBe(BigInt(0xffffff00))
  })

  it('parses /0 (match everything)', () => {
    const cidr = parseCidr('0.0.0.0/0')
    expect(cidr!.mask).toBe(0n)
    expect(cidr!.network).toBe(0n)
  })

  it('parses /32 (single host)', () => {
    const cidr = parseCidr('1.2.3.4/32')
    expect(cidr!.mask).toBe(BigInt(0xffffffff))
    expect(cidr!.network).toBe(BigInt(0x01020304))
  })

  it('parses IPv6 /64', () => {
    const cidr = parseCidr('2001:db8::/64')
    expect(cidr!.version).toBe(6)
    expect(cidr!.network).toBe(0x20010db8000000000000000000000000n)
    // Top 64 bits set, bottom 64 zero.
    expect(cidr!.mask).toBe(0xffffffffffffffff0000000000000000n)
  })

  it('rejects out-of-range prefix length', () => {
    expect(parseCidr('1.2.3.4/33')).toBeNull()
    expect(parseCidr('1.2.3.4/-1')).toBeNull()
    expect(parseCidr('2001:db8::/129')).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(parseCidr('1.2.3.4')).toBeNull()  // no /
    expect(parseCidr('/24')).toBeNull()      // no ip
    expect(parseCidr('xyz/24')).toBeNull()
  })
})

describe('ipInCidr', () => {
  const cidr24 = parseCidr('66.249.66.0/24')!
  const cidr6 = parseCidr('2001:4860:4801::/48')!

  it('matches IPs inside the IPv4 network', () => {
    expect(ipInCidr('66.249.66.1', cidr24)).toBe(true)
    expect(ipInCidr('66.249.66.255', cidr24)).toBe(true)
    expect(ipInCidr('66.249.66.0', cidr24)).toBe(true)
  })

  it('rejects IPs outside the IPv4 network', () => {
    expect(ipInCidr('66.249.67.1', cidr24)).toBe(false)
    expect(ipInCidr('1.2.3.4', cidr24)).toBe(false)
  })

  it('matches IPs inside the IPv6 network', () => {
    expect(ipInCidr('2001:4860:4801::1', cidr6)).toBe(true)
    expect(ipInCidr('2001:4860:4801:ffff::', cidr6)).toBe(true)
  })

  it('rejects IPs outside the IPv6 network', () => {
    expect(ipInCidr('2001:4860:4802::1', cidr6)).toBe(false)
  })

  it('does not cross-match IPv4 against IPv6 CIDR (or vice versa)', () => {
    expect(ipInCidr('66.249.66.1', cidr6)).toBe(false)
    expect(ipInCidr('2001:4860:4801::1', cidr24)).toBe(false)
  })
})

describe('verifyIpForRule', () => {
  it('verifies a known Googlebot IPv4 inside a published prefix', () => {
    // 192.178.4.0/27 is in the bundled googlebot.json (one of many
    // crawler prefixes). Pick an IP inside that /27 to verify the
    // match path works end-to-end against real publisher data.
    expect(verifyIpForRule('192.178.4.5', 'googlebot')).toBe(true)
  })

  it('verifies a known bingbot IPv4 inside a published prefix', () => {
    // 157.55.39.0/24 is in the bundled bingbot.json.
    expect(verifyIpForRule('157.55.39.10', 'bingbot')).toBe(true)
  })

  it('does not verify a random IP outside all Googlebot prefixes', () => {
    expect(verifyIpForRule('192.0.2.1', 'googlebot')).toBe(false)
    expect(verifyIpForRule('10.0.0.1', 'googlebot')).toBe(false)
  })

  it('verifies a known Anthropic ClaudeBot IPv4 inside the bundled prefix', () => {
    // 216.73.216.0/22 is the AWS-ANTHROPIC prefix — empirical Cloud
    // Run logs show all real ClaudeBot traffic comes from here.
    expect(verifyIpForRule('216.73.216.76', 'anthropic-claudebot')).toBe(true)
    expect(verifyIpForRule('216.73.217.125', 'anthropic-claudebot')).toBe(true)
    expect(verifyIpForRule('216.73.219.255', 'anthropic-claudebot')).toBe(true)
    // 160.79.104.0/21 is Anthropic's own ARIN allocation.
    expect(verifyIpForRule('160.79.104.5', 'anthropic-claudebot')).toBe(true)
    expect(verifyIpForRule('160.79.111.254', 'anthropic-claudebot')).toBe(true)
  })

  it('does not verify a random IP outside Anthropic prefixes', () => {
    expect(verifyIpForRule('1.2.3.4', 'anthropic-claudebot')).toBe(false)
    // Adjacent /22 outside the AWS-ANTHROPIC allocation.
    expect(verifyIpForRule('216.73.220.1', 'anthropic-claudebot')).toBe(false)
    // Adjacent /21 outside Anthropic's own allocation.
    expect(verifyIpForRule('160.79.112.1', 'anthropic-claudebot')).toBe(false)
    // bgp.tools had once attributed 209.249.57.0/24 to Anthropic's
    // AS60808; ARIN says it's Mitel Networks. Must NOT verify.
    expect(verifyIpForRule('209.249.57.10', 'anthropic-claudebot')).toBe(false)
  })

  it('verifies Anthropic IPv6 (entire /32 ANTHROPIC-V6 allocation)', () => {
    expect(verifyIpForRule('2607:6bc0::1', 'anthropic-claudebot')).toBe(true)
    expect(verifyIpForRule('2607:6bc0:11::cafe', 'anthropic-claudebot')).toBe(true)
    expect(verifyIpForRule('2607:6bc0:ffff:ffff::1', 'anthropic-claudebot')).toBe(true)
  })

  it('verifies Claude-User against the shared Anthropic ranges', () => {
    // Anthropic's per-user fetcher shares the ClaudeBot crawler's ARIN
    // allocation — the same bundled anthropic.json is keyed to both
    // rule ids in RULE_ID_TO_RANGES.
    expect(verifyIpForRule('216.73.216.76', 'claude-user')).toBe(true)
    expect(verifyIpForRule('160.79.104.5', 'claude-user')).toBe(true)
    expect(verifyIpForRule('2607:6bc0::1', 'claude-user')).toBe(true)
    // Outside Anthropic's allocation — stays unverified.
    expect(verifyIpForRule('1.2.3.4', 'claude-user')).toBe(false)
  })

  it('verifies Google-Agent against Google\'s user-triggered-agents ranges', () => {
    // user-triggered-agents.json is Google's shared list for every
    // user-triggered fetcher; the google-agent rule maps to it.
    expect(verifyIpForRule('136.122.0.10', 'google-agent')).toBe(true)    // 136.122.0.0/16
    expect(verifyIpForRule('136.121.16.5', 'google-agent')).toBe(true)    // 136.121.16.0/24
    expect(verifyIpForRule('2001:4860:c::5', 'google-agent')).toBe(true)  // IPv6 2001:4860:c::/124
    // Outside every published prefix — stays unverified.
    expect(verifyIpForRule('1.2.3.4', 'google-agent')).toBe(false)
  })

  it('returns false for a rule id without published ranges', () => {
    // Meta doesn't publish a public ranges file. The
    // meta-externalagent rule has no entry in RULE_ID_TO_RANGES, so
    // verification always returns false (caller stays
    // claimed_unverified).
    expect(verifyIpForRule('1.2.3.4', 'meta-externalagent')).toBe(false)
  })

  it('returns false for null / empty / malformed IP', () => {
    expect(verifyIpForRule(null, 'googlebot')).toBe(false)
    expect(verifyIpForRule(undefined, 'googlebot')).toBe(false)
    expect(verifyIpForRule('', 'googlebot')).toBe(false)
    expect(verifyIpForRule('not-an-ip', 'googlebot')).toBe(false)
  })

  it('handles IPv6 verification (Googlebot publishes both)', () => {
    // 2001:4860:4801:10::/64 is in the bundled googlebot.json.
    expect(verifyIpForRule('2001:4860:4801:10::1', 'googlebot')).toBe(true)
    // 2001:4860:4801:: (without the :10 in the 4th group) is OUTSIDE
    // every published /64 — the prefixes have specific 4th groups.
    expect(verifyIpForRule('2001:db8::1', 'googlebot')).toBe(false)
  })

  it('also verifies via the existing classifier path (UA + IP both match)', () => {
    // Tests in analysis.test.ts cover the full classifyCrawler path —
    // this duplicates the IP check at the raw layer for confidence.
    expect(verifyIpForRule('192.178.4.5', 'googlebot')).toBe(true)
  })
})

describe('hasVerificationDataFor', () => {
  it('is true for operators with bundled ranges', () => {
    expect(hasVerificationDataFor('googlebot')).toBe(true)
    expect(hasVerificationDataFor('bingbot')).toBe(true)
    expect(hasVerificationDataFor('openai-gptbot')).toBe(true)
    expect(hasVerificationDataFor('openai-chatgpt-user')).toBe(true)
    expect(hasVerificationDataFor('openai-searchbot')).toBe(true)
    expect(hasVerificationDataFor('perplexity-bot')).toBe(true)
    expect(hasVerificationDataFor('perplexity-user')).toBe(true)
    expect(hasVerificationDataFor('anthropic-claudebot')).toBe(true)
    expect(hasVerificationDataFor('claude-user')).toBe(true)
    expect(hasVerificationDataFor('google-agent')).toBe(true)
  })

  it('is false for operators without bundled ranges yet', () => {
    expect(hasVerificationDataFor('mistral-ai-user')).toBe(false)
    expect(hasVerificationDataFor('mistral-bot')).toBe(false)
    expect(hasVerificationDataFor('deepseek')).toBe(false)
    expect(hasVerificationDataFor('bytespider')).toBe(false)
    expect(hasVerificationDataFor('meta-externalagent')).toBe(false)
  })

  it('is false for unknown rule ids', () => {
    expect(hasVerificationDataFor('not-a-real-bot')).toBe(false)
    expect(hasVerificationDataFor('')).toBe(false)
  })
})
