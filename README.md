# ⚡ sats4ads

Bitcoin Lightning advertising platform. Advertisers pay in sats, viewers earn sats. No middlemen, no KYC.

🌐 **Live at:** [sats4ads.com](https://sats4ads.com)
🤖 **Bot:** [@LightningEasyBot](https://t.me/LightningEasyBot)

## Features

- **4 ad formats:** Broadcast DM · Group faucet · Channel ad · Web iframe
- **Anti-fraud:** HMAC-signed tokens, Telegram initData validation, UNIQUE claim constraint
- **Trilingual:** ES / EN / DE across all web pages
- **Double-entry ledger:** system balance always = 0
- **Group owner incentive:** 50% of commission goes to the group host

## Structure

```
server.js          API server (Node.js + Express, port 3900)
package.json
web/
  index.html       Landing page (trilingual)
  preview.html     Ad previewer
  manual.html      Complete manual (trilingual)
```

## API

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/ads` | secret | Sync ad from bot |
| POST | `/api/ads/:code/claim` | secret | Increment claim counter |
| POST | `/api/ads/:code/close` | secret | Deactivate ad |
| POST | `/api/token/:code` | — | Generate HMAC token (browser) |
| POST | `/api/claim-webapp` | — | Validate Telegram initData (Mini App) |
| GET | `/ad/:code` | — | Iframe ad widget |
| GET | `/preview` | — | Previewer page |
| GET | `/manual` | — | Manual page |

## Infrastructure

- **Server:** 87.106.111.49 · systemd `sats4ads-api.service`
- **Reverse proxy:** Caddy (auto SSL) · `/etc/caddy/Caddyfile`
- **Bot integration:** `/home/neo/lightning-telegram-bot/bot.js`

## Security

Claim tokens use HMAC-SHA256 with a shared secret:
```
payload = adCode + ":" + timestamp + ":" + nonce
token   = HMAC-SHA256(payload, SHARED_SECRET)[:32]
```
Tokens expire in 10 min and are single-use (stored in bot SQLite).

Telegram Mini App identity is verified via `initData` HMAC (bot token).
