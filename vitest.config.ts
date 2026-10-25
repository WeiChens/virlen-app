import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    // 默认 happy-dom：实测单文件环境开销 jsdom ≈0.68s / happy-dom ≈0.2s，全量 environment 汇总 196s → 68s、墙钟 22.3s → 15.5s（见 docs/agents/12-commands.md §7）。
    // 不碰 DOM 的用例仍在自己文件第一行写 `// @vitest-environment node`；反过来对 DOM 细节抠得细的（如启动屏的 CSS 百分比序列化）写 `// @vitest-environment jsdom` 回退。
    environment: 'happy-dom',
    // happy-dom 默认会去加载 `<script src>`（Monaco 的 AMD loader 因此抛出未处理拒绝）；测试里不需要真加载外部资源。
    environmentOptions: {
      happyDOM: {
        settings: {
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
        },
      },
    },
    // 线程池：同 heap、不用每个 worker 起一个 node 进程；实测 27.1s → 22.3s（连跑三次稳定全绿，见 §7）。
    pool: 'threads',
    include: ['src/tests/**/*.test.ts', 'src/tests/**/*.test.tsx'],
    exclude: ['node_modules', 'src-tauri', 'dist'],
    // 模拟 Tauri API（测试中不可用）
    setupFiles: ['./src/tests/setup.ts'],
  },
})
