# Bokerr Backend

Cloudflare Worker + Durable Object backend for Bokerr poker tables and wallet APIs.

## Local commands

```bash
npm install
npm run dev
npm run deploy
```

Required GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Set the real D1 `database_id` in `wrangler.toml` before deployment. Run migrations with:

```bash
npm run db:migrate
```

The Worker exposes `/health`, `/api/tables`, `/api/wallet`, `/api/withdraw`, `/ws/berlin-9max`, and `/ws/london-5max`.
