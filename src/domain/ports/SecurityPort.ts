import { AccessMode } from '../security/types'

export interface SecurityPort {
  isPathAllowed(
    targetPath: string,
    mode: AccessMode,
    workspace: string,
    blacklist: string[],
    whitelist: string[],
  ): Promise<{ allowed: boolean; reason: string }>
  getDefaultWhitelist(platform: 'windows' | 'macos' | 'linux'): string[]
  getDefaultBlacklist(platform: 'windows' | 'macos' | 'linux'): string[]
  canonicalizeList(dirs: string[]): Promise<
    {
      canonical: string
      raw: string
    }[]
  >
}
