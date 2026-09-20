import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AuthorizationModal from '@/ui/pages/chat/components/modals/authorization'

/**
 * 通用授权弹窗（AuthorizationModal）渲染回归。
 *
 * 背景：`AuthorizationRequest` 约定「`desc` = 正文（命令 / 脚本内容）、`command` = 实际运行命令」，
 * 由弹窗分两段渲染。曾经 `tool-ui.tsx` 只透传了 `desc`、漏传 `command`，导致脚本授权时
 * 看不到实际运行命令（如 `node temp/run.js`）。这里把「命令 + 正文两段都要展示」这条契约钉住。
 */
function render(props: Record<string, any> = {}) {
  return renderToStaticMarkup(
    <AuthorizationModal
      visible
      permName="script.execute"
      title="脚本命令执行"
      onConfirm={() => {}}
      onCancel={() => {}}
      onShelve={() => {}}
      {...props}
    />,
  )
}

describe('AuthorizationModal 授权弹窗', () => {
  it('脚本：desc（脚本正文）与 command（运行命令）分两段渲染', () => {
    const html = render({
      desc: "console.log('hi')",
      command: 'node temp/run.js',
    })
    // 运行命令行（.auth-desc-command）必须出现
    expect(html).toContain('auth-desc-command')
    expect(html).toContain('node temp/run.js')
    // 脚本正文
    expect(html).toContain('console.log')
    // 权限唯一 key 展示在标题栏
    expect(html).toContain('script.execute')
  })

  it('命令：仅 desc（本身即命令），不渲染多余的 command 段', () => {
    const html = render({
      permName: 'terminal.install.execute',
      title: '终端安装命令执行',
      desc: 'npm install',
    })
    expect(html).not.toContain('auth-desc-command')
    expect(html).toContain('npm install')
  })

  it('hint（风险 / 绕过沙盒警告）有则显示', () => {
    const html = render({
      permName: 'sandbox.command.execute',
      title: '沙盒脱壳·命令执行',
      desc: 'x',
      hint: '⚠️ 该命令申请「不使用沙盒」执行',
    })
    expect(html).toContain('auth-hint')
    expect(html).toContain('沙盒')
  })
})
