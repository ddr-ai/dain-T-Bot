import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build the PWA. Serve the dist/ folder statically behind the backend
// (or any static host) with the VITE_API_BASE pointing at the backend.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true }
    }
  }
})
