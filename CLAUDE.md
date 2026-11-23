# CLAUDE.md — Game Command V1.0

This repository builds **Game Command (GC) V1.0**: an offline-first operating system for one distribution truck in Zimbabwe (Mutare base). It covers trips, stock, USD/ZiG cash, the driver POS, customers, location, and a trip-close report.

## Source of truth
- **`GC_MASTER_PROMPT.md`**: product rules, scope, architecture, permissions, financial rulebook, acceptance scenarios and milestones. Read it in full at the start of every session. The owner edits it; you do not.
- **`STATE.md`**: where the build is. You keep it updated.
- **`DECISIONS.md`**: open questions and approved decisions. You add OPEN entries; only the owner approves or rejects them.

If anything in this file conflicts with `GC_MASTER_PROMPT.md`, the master prompt wins.

## Every session, in this order
1. **Read** `GC_MASTER_PROMPT.md`, `STATE.md` and `DECISIONS.md`. Summarise where we are in 5 lines.
2. **Check** that the owner has approved the current milestone before you start the next one. If the last milestone is marked AWAITING OWNER REVIEW and the owner hasn't approved it, stop and ask.
3. **Run the full test suite.** Fix any regression before doing new work.
4. **Plan** the next tasks for the current milestone (max 10 bullets: files to touch, tests to add).
5. **Build** in small commits. Write tests first for anything touching money, stock, sync or permissions.
6. **Verify:** typecheck, lint, unit and e2e. For UI work, check a 360px-wide viewport, offline mode, and 4× CPU throttling.
7. **Record:** update `STATE.md` and add new questions to `DECISIONS.md` as OPEN.
8. **Report** to the owner in plain language: what now works and how to try it, test results, decisions needed, next step.
9. **Stop** at the end of each milestone and wait for approval.

## Hard rules (never break these)
- Never violate Section 2 (non-negotiables) of the master prompt. If a task seems to require it, stop and ask.
- Never edit or delete rows in `trip_events`. Corrections are new reversal, replacement or adjustment events with a reason.
- Never use floating-point numbers for money. Use integer minor units plus a currency code; FX rates are decimal strings with source and timestamp.
- Keep USD and ZiG accountability separate. Consolidated figures are for display only.
- Never send product costs or margins to a Driver's device. COGS and trip economics are calculated on the server only.
- Never rely on the UI to enforce a permission. Enforce it in RLS **and** Edge Functions, and cover it with a test.
- Never make a driver action wait on the network. Save locally first and sync in the background.
- Never make GPS a condition of a sale. Record `location_status` and continue.
- Never add out-of-scope features (Section 3). Propose them in `DECISIONS.md` instead.
- Never seed test fixtures (Section 6 costs, prices, FX rate) into production.
- Never commit secrets. Use environment variables; the Maps key is restricted by HTTP referrer.
- If a business rule is unclear, ask. Do not guess and build on the guess.

## Stack (details in master prompt Section 4)
Vite + React + TypeScript PWA · Tailwind + shadcn/ui · Dexie (IndexedDB) outbox · Workbox service worker · Supabase (Postgres, Auth, RLS, Edge Functions, Storage) · Vercel · Zod shared schemas · Vitest + Playwright · Sentry.

## Repository layout
```
apps/web/src/driver     driver app (mobile, offline-first, no map)
apps/web/src/office     owner / accounts / warehouse screens
apps/web/src/shared     components, hooks, MapProvider, sync client
packages/engine         pure TS financial engine + scenario tests
packages/schema         Zod event schemas, types, permissions.ts
supabase/migrations     schema changes (never edit an applied migration)
supabase/functions      Edge Functions (ingest-events, approve, verify, close-trip)
supabase/seed           test fixtures — local and staging only
supabase/tests          RLS and permission tests
docs/                   owner guides
```

## Commands
<!-- The agent fills these in during M0 and keeps them current. -->
| Task | Command |
|---|---|
| Install | `npm install` |
| Dev server | `npm run dev` (http://localhost:5173, no service worker) · `npm run build && npm run preview` (http://localhost:4173, with service worker) |
| Typecheck / lint | `npm run typecheck` / `npm run lint` |
| Unit tests (engine) | `npm test` (all workspaces) · `npx vitest run packages/engine` (engine only) |
| E2E tests | `npm run test:e2e` (builds, serves on :4173, runs Playwright in Chrome) |
| Database tests (no Docker) | `npx vitest run --project supabase` (PGlite: migrations + RLS + permissions + ingestion + Edge handlers) |
| Local Supabase (needs Docker) | `supabase start` · stop: `supabase stop` |
| Apply migrations (local) | `supabase db reset` (applies `supabase/migrations`; not yet run, see STATE.md) |
| Edge Functions (local) | `supabase functions serve` |

## Definition of done for any task
- Tests written and passing, including every earlier milestone gate.
- No new TypeScript errors or lint warnings.
- `STATE.md` updated.
- Anything uncertain is recorded in `DECISIONS.md`, not decided silently.
