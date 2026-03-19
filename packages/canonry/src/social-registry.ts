import type { SocialPlatformAdapter, SocialPlatformName, SocialQuotaPolicy } from '@ainyc/canonry-contracts'

export interface RegisteredSocialPlatform {
  adapter: SocialPlatformAdapter
  quotaPolicy: SocialQuotaPolicy
}

/**
 * Registry of configured social platform adapters.
 * Mirrors the ProviderRegistry pattern used for AI providers.
 */
export class SocialPlatformRegistry {
  private platforms = new Map<SocialPlatformName, RegisteredSocialPlatform>()

  register(adapter: SocialPlatformAdapter, quotaPolicy: SocialQuotaPolicy): void {
    this.platforms.set(adapter.name, { adapter, quotaPolicy })
  }

  get(name: SocialPlatformName): RegisteredSocialPlatform | undefined {
    return this.platforms.get(name)
  }

  getAll(): RegisteredSocialPlatform[] {
    return [...this.platforms.values()]
  }

  getForProject(platformNames: SocialPlatformName[]): RegisteredSocialPlatform[] {
    // Empty array means "use all configured platforms"
    if (platformNames.length === 0) {
      return this.getAll()
    }
    const result: RegisteredSocialPlatform[] = []
    const seen = new Set<SocialPlatformName>()
    for (const name of platformNames) {
      if (seen.has(name)) continue
      seen.add(name)
      const platform = this.platforms.get(name)
      if (platform) result.push(platform)
    }
    return result
  }

  get size(): number {
    return this.platforms.size
  }
}
