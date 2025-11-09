# Progress Summary (2025-11-09)

## What’s Done
- Converted the Hono app (`src/index.tsx`) to use Cloudflare D1 for all reads/writes, including validation, search, modal UX fixes, and JSON API endpoints.
- Added modal trigger script hardening and UI polish (search-first layout, tags, guest posting).
- Wrote initial D1 schema in `schema.sql` and wired the binding via `wrangler.jsonc`.
- Documented the Notion batch + static-archive hybrid plan in `AGENTS.md` and `README.md`.

## Current Blockers / Issues
- Local `wrangler d1 execute` cannot run inside this Codex environment because `wrangler` attempts to write logs under `/Users/n0bisuke/Library/Preferences/.wrangler/logs`, which is not writable here (EPERM). Node/npm binaries exist under `~/.nvm/versions/node/v25.1.0/bin`, but Wrangler still fails at the logging step.
- Consequently the D1 database has not yet been migrated; `npm run dev` will still throw `D1_ERROR: no such table: entries` until the schema is applied on the real machine.

## Recommended Next Actions
1. On a normal terminal (where you have npm + wrangler access), run:
   ```bash
   wrangler d1 create referencehub   # if not yet created
   wrangler d1 execute referencehub --file=schema.sql
   ```
   Update the real `database_id` in `wrangler.jsonc`.
2. Optionally add npm scripts (e.g., `"d1:migrate"`) to call the above command locally for future migrations.
3. Once the schema exists, restart `npm run dev` and verify posting/searching works against D1.
4. Proceed with Cron Worker for Notion sync + static archive export per `AGENTS.md` next steps.
