import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build the PWA. Serve the dist/ folder statically behind the backend
// (or any static host) with the VITE_API_BASE pointing at the backend.
//
// GH_PAGES=1 builds for the GitHub Pages project site (served under the
// /dain-T-Bot/ subpath): Vite rewrites asset URLs to that base, the API base
// points at the deployed engine (its CORS policy is open), and the service
// worker + manifest use relative scopes so the same build logic works at
// both the Netlify root and the Pages subpath.
export default defineConfig({
  base: process.env.GH_PAGES ? '/dain-T-Bot/' : '/',
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
