import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite dev server proxies REST and WSS to the review server (default 4317).
// Run the server with ORIGIN=http://localhost:5173 so the session cookie and
// pairing callbacks share this page's origin in dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4317',
        changeOrigin: false,
      },
      '/ws': {
        target: 'ws://localhost:4317',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
