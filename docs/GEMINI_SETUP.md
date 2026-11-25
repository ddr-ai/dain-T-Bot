# Gemini API Setup Guide

This bot trades spot only, long only, with no leverage. This guide gets you a
Gemini API key that can read balances and place orders, but can never withdraw.

## 1. Create the API key

1. Sign in to Gemini and open Account -> API Settings (console.gemini.com).
2. Create a new API key (sandbox keys are separate - see below).
3. Set permissions to EXACTLY:
   - Account Balances (read)
   - Orders (trade)
4. Leave Withdrawals DISABLED. This is mandatory. A key that cannot withdraw
   limits the worst case for anyone who steals the key.
5. Optionally restrict the key to a single IP address if your backend host has
   a fixed IP.
6. Copy the key and the secret immediately. Gemini shows the secret only once.

## 2. Choose the API base URL

- Paper/sandbox trading (recommended first):

    GEMINI_BASE_URL=https://api.sandbox.gemini.com

- Live trading:

    GEMINI_BASE_URL=https://api.gemini.com

Note: this repository's PAPER mode does not need any Gemini key at all - it
simulates fills locally against the live public price feed. The sandbox URL +
sandbox key combination is for testing the real order pipeline (order
placement, stop-limit orders, cancellations) with play money.

## 3. Put the key in the backend

HOSTED ENGINE (https://dain-t-bot.netlify.app): open Settings in the PWA or
iOS app, paste the key + secret there. They are stored AES-256-GCM encrypted
in the site's private Netlify Blobs, sealed with the CREDS_MASTER_KEY
environment variable. No .env, no server to run.

Standalone backend:

Preferred (encrypted at rest):

- Open Settings in the app and paste the key + secret. They are stored
  AES-256-GCM encrypted in backend/data/credentials.enc using ENCRYPTION_KEY.
- Requires ENCRYPTION_KEY to be set in .env.

Alternative (env file):

    GEMINI_API_KEY=your_key
    GEMINI_API_SECRET=your_secret

.env is git-ignored; never commit it. The backend never logs secrets.

## 4. Set your fee tier

Gemini charges maker/taker fees by 30-day volume tier. The base tier is about
0.20% maker / 0.40% taker; ActiveTrader tiers go lower. Update:

    MAKER_FEE_BPS=20
    TAKER_FEE_BPS=40

in .env to match your tier. The risk engine subtracts these fees from every
projected reward before allowing a trade.

## 5. Verification checklist

- [ ] Key has Balances + Orders only.
- [ ] Withdrawals disabled on the key.
- [ ] .env has the correct base URL (sandbox first).
- [ ] PAPER_TRADING=true for the first runs.
- [ ] ENCRYPTION_KEY set with a fresh random 32-byte base64 string:

    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

## 6. Important notes

- Gemini spot symbols use lowercase pairs: btcusd, ethusd, solusd.
- Gemini API v1 private endpoints require HMAC-SHA384 signed payloads with a
  strictly increasing nonce; this backend serializes nonces through a mutex so
  concurrent requests never collide.
- Public market data (prices, candles, order books) always comes from
  api.gemini.com even in paper mode, so strategy decisions use real prices.
