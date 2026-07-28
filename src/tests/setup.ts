/**
 * 测试环境初始化 — Mock Tauri API
 *
 * Tauri 的 @tauri-apps/api 在 Node.js 测试环境中不可用，
 * 所有测试中涉及 Tauri 调用的模块需要被 Mock。
 *
 * ⚠️ vi.mock() 会被 Vitest 提升（hoist）到文件最顶部，
 *    因此 import { vi } 必须在 vi.mock() 之前书写。
 *    Vitest 运行时已提供全局 vi（globals: true），
 *    但编辑器需要显式 import 才能获得类型提示。
 */
import { vi } from 'vitest'

// Mock @tauri-apps/api/core 的 invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

// Mock @tauri-apps/plugin-fs
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  readDir: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
  copyFile: vi.fn(),
}))

// Mock @tauri-apps/plugin-shell
vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: class MockCommand {
    static create() {
      return new MockCommand()
    }
    stdout = { on: vi.fn() }
    stderr = { on: vi.fn() }
    spawn = vi.fn()
  },
  Child: class MockChild {
    pid = 0
    kill = vi.fn()
  },
}))

// Mock @tauri-apps/plugin-dialog
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
  open: vi.fn(),
}))

// Mock @tauri-apps/api/path
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(() => Promise.resolve('/mock/app/data')),
  resourceDir: vi.fn(() => Promise.resolve('/mock/resources')),
  documentDir: vi.fn(() => Promise.resolve('/mock/documents')),
}))

// Mock @tauri-apps/plugin-http
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
      body: null,
    }),
  ),
}))

// Mock @tauri-apps/api/window
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    show: vi.fn(),
    hide: vi.fn(),
  })),
}))

// Mock 全局 fetch（用于 AI provider HTTP 请求）
// @ts-ignore
global.fetch = vi.fn(() =>
  Promise.resolve(
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ),
)
