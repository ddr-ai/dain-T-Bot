import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './styles.css'

const root = createRoot(document.getElementById('root')!)
root.render(
  <StrictMode>
    <App />
  </StrictMode>
)

// Register the service worker in production builds (offline + install).
// BASE_URL reflects the Vite base ('/' on a root host, '/dain-T-Bot/' on
// GitHub Pages), so the same code works at any subpath.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const swUrl = (import.meta.env.BASE_URL ?? '/') + 'sw.js'
  navigator.serviceWorker.register(swUrl).catch(() => {
    /* offline support optional */
  })
}
