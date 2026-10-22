import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

// Tauri 的移动端调试地址（`tauri android/ios dev` 时由 CLI 注入）；注意 `process` 的类型
// 来自下面 `node:fs` / `node:path` 带进来的 `@types/node`，删掉它们就得把这个声明换成
// 别的写法（旧版这里挂的是 `@ts-expect-error`）
const host = process.env.TAURI_DEV_HOST

/**
 * pdfjs 的 `cmaps` / `standard_fonts` 要在**运行时按目录**取用（不是能打进 JS 的模块）：
 * 中文 PDF 里没嵌字体的文本要靠 cMaps 才能映射到字形，缺了会整段空白（见 `pdf-view.tsx`）。
 *
 * 所以把 `node_modules/pdfjs-dist/{cmaps,standard_fonts}` 原样搬到 `/pdfjs/...`：
 * - **dev**：一段静态中间件直接从 node_modules 读（不复制进 `public/`，仓库里不会多出 185 个二进制文件）；
 * - **build**：在 `generateBundle` 里 emit 成独立产物（安装包里自带，离线可用）。
 */
function pdfjsAssets(): Plugin {
  const roots = ['cmaps', 'standard_fonts']
  const sourceDir = (root: string) => path.resolve(process.cwd(), 'node_modules/pdfjs-dist', root)
  return {
    name: 'virlen-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0]
        if (!url.startsWith('/pdfjs/')) return next()
        const rel = decodeURIComponent(url.slice('/pdfjs/'.length))
        // ⚠️ dev 服务器只放行这两个资源目录：只靠拦截 `..` 不够 ——
        // 客户端（或代理）会先把 `..` 归一化掉，`/pdfjs/cmaps/../package.json` 到这里已经是
        // `package.json`，于是整个 pdfjs-dist 目录都可读。白名单一行就把它封住。
        if (!roots.some((root) => rel.startsWith(`${root}/`)) || rel.includes('..')) {
          return next()
        }
        const file = path.resolve(process.cwd(), 'node_modules/pdfjs-dist', rel)
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next()
        res.setHeader('Content-Type', rel.endsWith('.bcmap') ? 'application/octet-stream' : 'font/ttf')
        fs.createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      for (const root of roots) {
        const dir = sourceDir(root)
        if (!fs.existsSync(dir)) continue
        for (const name of fs.readdirSync(dir)) {
          const file = path.join(dir, name)
          // 只搬文件：`cmaps` 目录里没有子目录，多一层判断免得把意外目录当成文件读
          if (!fs.statSync(file).isFile()) continue
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${root}/${name}`,
            source: fs.readFileSync(file),
          })
        }
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), pdfjsAssets()],
  resolve: {
    alias: {
      '@': '/src',
      // ⚠️ Monaco 的 codicon 图标字体（见 `src/monaco/setupMonaco.ts` 的文件头）：包的 `exports`
      // 把**任意子路径**重写成 `esm/vs/*.js`，所以磁盘上那份 `.../codicon.css` 解析不到
      // （实测直接引 = 构建期 failed to resolve），只能用别名落到这一份。
      '@mono-codicon':
        '/node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon',
    },
  },
  optimizeDeps: {
    // monaco-editor 由 setupMonaco 按“子模块入口”引入，禁止依赖预打包，
    // 否则各个子入口可能被打成多份、产生多个 monaco 实例（注册会互相隔离）。
    exclude: ['monaco-editor'],
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {},
      },
    },
  },
}))
