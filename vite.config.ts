import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': '/src',
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
