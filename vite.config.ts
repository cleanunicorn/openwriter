import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { SERVER_PORT, VITE_PORT } from './src/shared/ports.ts'

// The dev server listens on every interface and proxies the API to the Node server, which stays
// on loopback. The server's Host check accepts this machine's LAN addresses in dev only.

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: { outDir: '../../dist/client', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: {
    host: true,
    port: VITE_PORT,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${SERVER_PORT}` } },
  },
})
