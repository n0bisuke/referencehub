## Setup

```bash
npm install
```

## Database Migrations

This project uses Cloudflare D1 with migrations for database schema management.

### Local Development

Run migrations on local D1 database:
```bash
npm run d1:migrate:local
```

Start development server (automatically runs local migrations):
```bash
npm run dev
```

### Production Deployment

Deploy to Cloudflare Workers (automatically runs remote migrations):
```bash
npm run deploy
```

Or run migrations manually on production:
```bash
npm run d1:migrate
```

### Adding New Migrations

1. Create a new migration file in `migrations/` directory
2. Name it sequentially (e.g., `0003_description.sql`)
3. Test locally with `npm run d1:migrate:local`
4. Deploy with `npm run deploy`

**Note**: Never modify existing migration files. Always create new ones for schema changes

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
npm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```

## Architecture Notes

- Frontend/UI is powered by Hono on Cloudflare Workers + Vite SSR components. Guests search public submissions, open a modal to post a URL + note + tags, and最新投稿はD1から動的に取得、過去ログは静的アーカイブへ切り替える設計。
- **Persistence roadmap**:
  - **D1 Primary Store**: All new submissions first land in D1 (URL, note, tags, hostname, timestamps). D1 free tier (5 GB, 500万 read/day, 10万 write/day) covers the MVP.
  - **Notion Sync (Batch)**: A scheduled Worker (Cron Trigger) periodically reads “unsynced” rows from D1, writes them to a Notion database via the Notion API (rate limit 3 req/sec), and marks them as synced. This keeps a human-friendly archive in Notion for manual curation.
  - **Static Archive Layer**: Past submissions (e.g., older than the latest 100) are exported from D1/Notion into static JSON files served via Cloudflare Pages/Workers `assets`. The homepage fetches recent entries dynamically, while older entries are loaded from the static archive for near-zero runtime cost.
  - **Hybrid Delivery**: Latest content = dynamic Worker API (fast, cacheable); historical content = static files cached on CDN + Notion views for internal review. This reduces Worker request volume while keeping recent posts fresh.
- **Media Strategy**: If screenshots or OG images are required, store them in Cloudflare R2 (10 GB free) and generate thumbnails with Cloudflare Images (5,000 unique transformations/month free). Static archives can reference these pre-generated URLs.
- **Auth Roadmap**: Start with guest submissions → add lightweight email/OTP auth → upgrade to WebAuthn passkeys when multi-user/private workspaces are needed.
