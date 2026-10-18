# Bokerr Backend

Cloudflare Worker for Bokerr guest sessions and poker tables. The Worker is deployed as `bokerr-api` from this repository.

## Storage and session model

- `SESSION_KV` stores anonymous session metadata keyed by the SHA-256 hash of a random 256-bit session token. Session records expire after 30 days.
- `PokerTable` Durable Objects coordinate live WebSocket connections and persist the authoritative round state. KV is not used for live turn or round state.
- The Android app keeps the session token in its private app preferences and sends it as a Bearer token for HTTP requests. WebSockets use the `bokerr-v1` subprotocol plus the token; the token is not placed in the URL.
- These are guest sessions, not account authentication. Do not use them for identity-sensitive or financial functions.

## API

- `GET /health`
- `GET /api/tables`
- `POST /api/session` creates a guest session; `GET`, `PUT`, and `DELETE /api/session` read, update, or revoke it.
- `wss://<worker>/ws/berlin-9max` and `wss://<worker>/ws/london-5max` connect to a table and require a valid session.

Wallet, withdrawal, and SMS-payment endpoints are not exposed by the current Worker. Historical wallet tables remain in `schema.sql`/D1 and are intentionally not dropped, to avoid deleting existing data.

## Local checks and deployment

```bash
npm install
npx wrangler deploy --dry-run
npm run dev
npm run deploy
```

The checked-in `wrangler.toml` binds `SESSION_KV`, the `PokerTable` Durable Object namespace, and the existing D1 database. GitHub Actions deploys this Worker on pushes to `main` using the `CLOUDFLARE_API_TOKEN` repository secret. Never commit API tokens or other secret values.
