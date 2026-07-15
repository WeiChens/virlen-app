import {
  tryCanonicalize,
  tryCanonicalizePartial,
} from '@/utils/pathCanonicealize'
import { SecurityPort } from '../ports/SecurityPort'
import { AccessMode } from './types'

class SecurityPortImpl implements SecurityPort {
  async canonicalizeList(dirs: string[]): Promise<
    {
      canonical: string
      raw: string
    }[]
  > {
    const result: { canonical: string; raw: string }[] = []
    for (const dir of dirs) {
      const c = await tryCanonicalize(dir)
      if (c) {
        result.push({ canonical: c, raw: dir })
      }
    }
    return result
  }
  async isPathAllowed(
    targetPath: string,
    mode: AccessMode,
    workspace: string,
    blacklist: string[],
    whitelist: string[],
  ): Promise<{ allowed: boolean; reason: string }> {
    const canonicalTarget = await tryCanonicalizePartial(targetPath)
    if (!canonicalTarget) {
      return { allowed: false, reason: '路径无法解析' }
    }

    // 1. 黑名单 > 一切
    const canonBlacklist = await this.canonicalizeList(blacklist)
    for (const { canonical } of canonBlacklist) {
      if (
        canonicalTarget === canonical ||
        canonicalTarget.startsWith(canonical + '/')
      ) {
        return {
          allowed: false,
          reason: `路径已被黑名单拦截: ${targetPath}`,
        }
      }
    }

    // 2. 白名单 > 工作目录
    const canonWhitelist = await this.canonicalizeList(whitelist)
    for (const { canonical } of canonWhitelist) {
      if (
        canonicalTarget === canonical ||
        canonicalTarget.startsWith(canonical + '/')
      ) {
        return { allowed: true, reason: '' }
      }
    }

    // 3. 工作目录
    const rawWorkspace = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
    const canonicalWorkspace = await tryCanonicalize(rawWorkspace)
    if (canonicalWorkspace) {
      if (
        canonicalTarget === canonicalWorkspace ||
        canonicalTarget.startsWith(canonicalWorkspace + '/')
      ) {
        return { allowed: true, reason: '' }
      }
    }

    // 4. 其他路径
    if (mode === 'w') {
      return {
        allowed: false,
        reason: `路径不在白名单或工作目录内，且写权限仅允许白名单与工作目录`,
      }
    }
    return { allowed: true, reason: '' }
  }
  /**
   * 各平台默认黑名单目录。
   * Windows 保护系统目录 + %USERPROFILE% 下的敏感路径；
   * macOS/Linux 保护系统目录 + ~ 下的敏感路径。
   */
  getDefaultBlacklist(platform: 'windows' | 'macos' | 'linux'): string[] {
    const common = [
      '/etc/shadow',
      '/etc/passwd',
      '/etc/ssh',
      '/etc/sudoers',
      '/etc/hosts',
      '/etc/ssl',
      '/etc/kubernetes',
      '/etc/docker',
      '/etc/systemd',
      '~/.ssh',
      '~/.gnupg',
      '~/.aws',
      '~/.azure',
      '~/.kube',
      '~/.config/gcloud',
      '~/.docker',
      '~/.netrc',
      '~/.npmrc',
      '~/.env',
      '~/.bashrc',
      '~/.zshrc',
      '~/.profile',
      '~/.bash_history',
      '~/.zsh_history',
      '~/.gitconfig',
      '~/.ssh/authorized_keys',
      '~/.ssh/id_rsa',
      '~/.ssh/id_rsa.pub',
      '~/.ssh/config',
    ]

    switch (platform) {
      case 'windows':
        return [
          ...common.filter(
            (p) =>
              !p.startsWith('/etc/') &&
              !p.startsWith('~/.ssh') &&
              !p.startsWith('~/.bash') &&
              !p.startsWith('~/.zsh'),
          ),
          'C:/Windows',
          'C:/Windows/System32',
          'C:/Windows/System32/config',
          'C:/Windows/System32/drivers/etc',
          'C:/Program Files',
          'C:/Program Files (x86)',
          'C:/ProgramData',
          'C:/Users/All Users',
          'C:/Boot',
          'C:/System Volume Information',
          'C:/Recovery',
          '%USERPROFILE%/.ssh',
          '%USERPROFILE%/.gnupg',
          '%USERPROFILE%/.aws',
          '%USERPROFILE%/.azure',
          '%USERPROFILE%/.kube',
          '%USERPROFILE%/.docker',
          '%USERPROFILE%/.gitconfig',
          '%USERPROFILE%/AppData/Roaming/Microsoft',
          '%USERPROFILE%/AppData/Roaming/npm',
          '%USERPROFILE%/AppData/Local/Google',
          '%USERPROFILE%/AppData/Local/Microsoft',
        ]

      case 'macos':
        return [
          ...common,
          '/etc',
          '/var',
          '/System',
          '/Applications',
          '/Library',
          '/System/Library',
          '/private/etc',
          '/private/var',
          '/Users/Shared',
          '/cores',
          '/Volumes',
          '/Network',
          '~/.Trash',
          '~/.spotlight',
          '~/.fseventsd',
          '~/Library',
          '~/Library/Preferences',
          '~/Library/Application Support',
          '~/Library/Keychains',
          '~/Library/Caches',
          '~/Library/Logs',
        ]

      case 'linux':
        return [
          ...common,
          '/etc',
          '/var',
          '/boot',
          '/usr',
          '/bin',
          '/sbin',
          '/lib',
          '/lib64',
          '/opt',
          '/root',
          '/sys',
          '/proc',
          '/dev',
          '/snap',
          '/lost+found',
          '~/.local/share',
          '~/.config',
          '~/.cache',
        ]
    }
  }

  /**
   * 各平台默认黑名单目录。
   * Windows 保护系统目录 + %USERPROFILE% 下的敏感路径；
   * macOS/Linux 保护系统目录 + ~ 下的敏感路径。
   */
  getDefaultWhitelist(platform: 'windows' | 'macos' | 'linux'): string[] {
    switch (platform) {
      case 'windows':
        return [
          '%USERPROFILE%/AppData/Local/Temp',
          'C:/Windows/Temp',
          '%USERPROFILE%/Documents',
        ]

      case 'macos':
        return ['$TMPDIR', '/private/var/tmp/']

      case 'linux':
        return ['/tmp', '/var/tmp']
    }
  }
}

export const securityPort: SecurityPort = new SecurityPortImpl()
