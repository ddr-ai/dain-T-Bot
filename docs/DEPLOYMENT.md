# Deployment Guide

The backend is one Node.js process with zero npm dependencies (Node 22+
required because it runs TypeScript natively via --experimental-transform-types).
That makes hosting simple: any platform with Node 22 works.

## Security first

- The REST API accepts Bearer auth (API_AUTH_TOKEN). Set it whenever the
  backend is reachable from the internet - the emergency-stop endpoint and
  settings endpoints are powerful.
- Gemini credentials are stored AES-256-GCM encrypted (ENCRYPTION_KEY).
- CORS allows all origins; auth is the gate. Frontend apps run on different
  origins by design.
- Never expose your Gemini key with withdrawals enabled (see
  docs/GEMINI_SETUP.md).

## Option 1 - Any VPS (most control, free tier on Oracle/uttle SSH boxes)

    # on the server (Ubuntu example)
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs git
    git clone https://github.com/ddr-ai/dain-T-Bot.git
    cd dain-T-Bot
    cp .env.example .env    # edit it: paper mode first, ENCRYPTION_KEY, API_AUTH_TOKEN
    cd backend
    npm start

Run it under systemd (Restart=always) or pm2 (npm i -g pm2; pm2 start
"npm start" --name autopilot). Put nginx/caddy in front for HTTPS and proxy
/rest to the backend port; WSS works through the same proxy upgrade headers.

Example Caddyfile (automatic TLS):

    autopilot.example.com {
      reverse_proxy 127.0.0.1:3000
    }

## Option 2 - PaaS free tiers

- Render / Railway / Fly.io free or low tiers work: set start command
  npm start in backend/, set the env vars from .env.example in the
  dashboard, expose port from PORT.
- Sleeping instances (free tiers) stop the bot - trading requires an
  always-on process. Choose a paid always-on instance or the VPS route
  once you are satisfied with paper results.

## Hosting the PWA (static)

    cd pwa
    npm install
    npm run build

dist/ is a fully static site. Deploy it to Netlify / Vercel / GitHub Pages /
Cloudflare Pages and set VITE_API_BASE to your backend base URL at build
time:

    VITE_API_BASE=https://autopilot.example.com npm run build

Install to home screen: iOS Safari -> Share -> Add to Home Screen;
Android Chrome -> install prompt or menu-> Install app.

Simplest alternative: serve the PWA from the same origin as the API behind one
Caddy/nginx vhost - then no CORS or VITE_API_BASE is needed at all.

## Docker (optional)

The repo intentionally has no Dockerfile; a minimal one:

    FROM node:22-alpine
    WORKDIR /app
    COPY . .
    WORKDIR /app/backend
    ENV NODE_ENV=production
    EXPOSE 3000
    CMD ["node", "--experimental-transform-types", "--no-warnings", "src/index.ts"]

Note: backend/data (state + credentials vault) must be a mounted volume to
survive container restarts.

## Operations notes

- State (positions, trades, activity, settings, paper balances) persists to
  backend/data/state.json with atomic writes; you can stop/start freely.
  On shutdown the engine persists state but does NOT flatten positions -
  resting stop/target orders stay live on Gemini, so you are protected
  while the process is down.
- The stale-price kill switch pauses NEW entries after 60s without ticks.
  Exits are exchange-side stop-limit orders, so they keep working even if
  the bot process dies.
- Check /api/health for liveness; /api/status for the full snapshot.
- Logs go to stdout (never contain secrets).
