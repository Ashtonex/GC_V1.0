# GC V1.0 — STATE
Last updated: 2026-11-26 (Africa/Harare) by agent session 5
Current milestone: M2 — Database schema, auth, roles, device registration, RLS, idempotent ingestion
Status: AWAITING OWNER REVIEW (verified on real local Supabase Postgres 17 + Deno Edge Runtime)
Previous: M1 — Financial engine — APPROVED 2026-11-23 (M-001)

## Done this session
- Started local Supabase stack via Docker (Postgres 17.6, GoTrue Auth, PostgREST, Kong, Edge Runtime `1.74.2` / Deno `2.1.4`, Realtime, pg-meta).
- Applied all 4 migrations (`0001_core.sql`–`0004_actions.sql`) cleanly on real Supabase Postgres 17 (`supabase start` and `supabase db reset`).
- Ran all 80 `supabase` Vitest tests (`permissions.test.ts` 38, `ingest.test.ts` 17, `scenarios-via-api.test.ts` 12, `handlers.test.ts` 11, `smoke.test.ts` 2) against real Postgres 17 via `GC_TEST_DATABASE_URL`: **80/80 passed**.
- Verified all 4 Edge Functions (`ingest-events`, `approve`, `verify`, `close-trip`) live in the Deno Edge Runtime over HTTP with a real GoTrue JWT (`_shared/supabase.ts` + `deno.json` import maps into `packages/schema` and `packages/engine`).
- Recorded owner approvals (`D-050`–`D-054`, `D-056`–`D-059`, `D-012`, `P-005`) in `DECISIONS.md`.

## Tests
- Scenarios: A ✔  B ✔  B2 ✔  C ✔ (engine, M1) · A, B, B2, C via the ingest API = M1 results ✔ (M2, verified on both PGlite and real Postgres 17) · final states via close-trip: A CLOSED ✔, B CLOSED_WITH_EXCEPTIONS ✔, B2 CLOSED ✔, C CLOSED_WITH_EXCEPTIONS ✔ · D3 ✔ D4 ✔ D2 ✔ at API level · D1, D5 full, E full ✘ (M3, need the sync client)
- Permission matrix: 29/29 rows have an enforcement test (meta-test checks none is missing); separation-of-duties rules 1–4, D-027, Owner two-factor and anon tested on both PGlite and real Postgres 17.
- Typecheck ✔ / lint ✔ / prettier ✔ / unit ✔ 182 passed (11 files: engine 59, schema 38, web 5, database + Edge handlers 80) / real Supabase Postgres 17 ✔ 80 passed (5 files) / Deno Edge Functions HTTP smoke ✔ (all 4 endpoints) / e2e ✔ 3 passed (Playwright)
- No UI changes this milestone (no 360px manual UI check needed; Playwright E2E runs Pixel 7 mobile viewport + offline reload).

## Next 3 tasks
1. Owner confirmation of **M2 sign-off** and clarification on `D-055` (keep rejecting late sales vs. accept when `occurred_at < returned_at`).
2. M3: Dexie outbox + sync client; Scenarios D (D1–D4) and E through a sync test harness.
3. Optional staging deploy (when owner logs into `anfdrxfrkwridyamitpx`): `supabase link --project-ref anfdrxfrkwridyamitpx && supabase db push && supabase functions deploy --use-api`.

## Blockers / owner decisions needed
- **Awaiting M2 sign-off** (local real-Supabase verification is now complete).
- **`D-055` clarification needed before M3:** keep rejecting late-arriving offline sales into `ingest_exceptions` vs. accept if `occurred_at < returned_at`.
- **Staging CLI link (`anfdrxfrkwridyamitpx`):** current `supabase` CLI login returns 403 for `anfdrxfrkwridyamitpx` (not a blocker for M3 local dev, needed before staging deploy).
- Still open: D-002 (Vercel preview + staging link), D-004 (Sentry/error monitoring before M3), D-013, D-018, D-049, D-001, D-038, P-001…P-004.

## Known risks / tech debt
- Fast/CI database tests use PGlite (Postgres 18) with an auth stub (`P-005`), while real Supabase Postgres 17.6 + GoTrue Auth + Deno Edge Runtime `1.74.2` passed all 80 tests and live HTTP Edge Function checks locally (`GC_TEST_DATABASE_URL`).
- Edge Function entry points and their `deno.json` import maps point into `packages/` (outside `supabase/functions`). Local Deno runtime (`supabase_edge_runtime`) resolves them cleanly; `supabase functions deploy --use-api` bundling on hosted Supabase still needs to be confirmed once `anfdrxfrkwridyamitpx` is linked.
- Create-user (Owner) needs the Supabase admin API; deferred to M4 (D-031). Roles and profiles are already Owner-only by RLS.
- Location ping ingestion is not built yet (table and RLS only); M3/M8.
- The safety-defect dispatch block waits for the M5 departure checklist (D-059).
- `npm audit`: 4 moderate advisories in build-time deps (via vite-plugin-pwa → workbox-build). Not shipped to phones.
- TypeScript pinned to ~6.0 (typescript-eslint does not support TS 7 yet).
- The background-location limitation of PWAs (Section 5) still applies; M9 only with approval.
