# GC V1.0 — STATE
Last updated: 2026-11-25 (Africa/Harare) by agent session 4
Current milestone: M2 — Database schema, auth, roles, device registration, RLS, idempotent ingestion
Status: AWAITING OWNER REVIEW (gate passes on in-process Postgres; real Supabase verification blocked on Docker / CLI login to `anfdrxfrkwridyamitpx`)
Previous: M1 — Financial engine — APPROVED 2026-11-23 (M-001)

## Done this session
- Re-verified full M0–M2 suite on `GCV1.0`: lint, typecheck, format check, 182 unit/database tests (including 80 Postgres/Edge handler tests on PGlite), and 3 Playwright offline/no-map E2E tests all pass.
- Formatted and committed the `GC_TEST_DATABASE_URL` test harness update (`supabase/tests/harness/db.ts`, `package.json`, `package-lock.json`) so the 80-test database suite can run against a local Postgres instance once Docker is running.
- Connected GitHub remote `origin` (`https://github.com/Ashtonex/GC_V1.0.git`, D-003) and pushed `main` so GitHub Actions CI runs.
- Checked Supabase CLI access for the owner's Supabase project (`anfdrxfrkwridyamitpx`): `supabase/config.toml` already exists (`supabase init` not re-run), but the current CLI session is logged into a different account (HTTP 403 on `anfdrxfrkwridyamitpx`), and Docker Desktop is not running (`dockerDesktopLinuxEngine` pipe missing).

## Tests
- Scenarios: A ✔  B ✔  B2 ✔  C ✔ (engine, M1) · A, B, B2, C via the ingest API = M1 results ✔ (M2) · final states via close-trip: A CLOSED ✔, B CLOSED_WITH_EXCEPTIONS ✔, B2 CLOSED ✔, C CLOSED_WITH_EXCEPTIONS ✔ · D3 ✔ D4 ✔ D2 ✔ at API level · D1, D5 full, E full ✘ (M3, need the sync client)
- Permission matrix: 29/29 rows have an enforcement test (meta-test checks none is missing); separation-of-duties rules 1–4, D-027, Owner two-factor and anon tested. Mutation check: switching off two separation-of-duties rules made 4 tests fail.
- Typecheck ✔ / lint ✔ / prettier ✔ / unit ✔ 182 passed (11 files: engine 59, schema 38, web 5, database + Edge handlers 80) / e2e ✔ 3 passed (Playwright)
- No UI changes this session (no 360px manual UI check needed; Playwright E2E runs Pixel 7 mobile viewport + offline reload).

## Next 3 tasks
1. Run M2 against real Supabase: either (a) clear Docker Desktop so `supabase start`, `supabase db reset`, `GC_TEST_DATABASE_URL` Vitest run, and `supabase functions serve` can run locally; and/or (b) run `supabase login` as the account owning `anfdrxfrkwridyamitpx`, then `supabase link --project-ref anfdrxfrkwridyamitpx`, `supabase db push`, and `supabase functions deploy --use-api`.
2. Clarify `D-055` (keep rejecting late sales vs. accept when `occurred_at < returned_at`) and confirm final **M2 sign-off**.
3. M3: Dexie outbox + sync client; Scenarios D (D1–D4) and E through a sync test harness.

## Blockers / owner decisions needed
- **Docker Desktop engine still not running** (`open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`), blocking `supabase start`, `supabase functions serve`, and running the 80-test suite against local real Postgres (`GC_TEST_DATABASE_URL`).
- **Supabase CLI account mismatch for `anfdrxfrkwridyamitpx`:** `supabase projects list` shows a different account (`Nirvana`, `UNSTPBL`, `nyangacamp2026`) and `anfdrxfrkwridyamitpx` returns 403. Owner needs to run `supabase login` for the account that owns `anfdrxfrkwridyamitpx` and supply the DB password for `supabase link --project-ref anfdrxfrkwridyamitpx` + `supabase db push`.
- **`D-055` clarification needed before M3:** `D-050`–`D-054`, `D-056`–`D-059`, `D-012`, and `P-005` were approved (2026-11-25); `D-055` needs an explicit choice (keep rejecting late-arriving sales vs. accept if `occurred_at < returned_at`).
- Still open: D-002 (Vercel preview + Supabase link), D-004 (Sentry/error monitoring before M3), D-013, D-018, D-049, D-001, D-038, P-001…P-004.

## Known risks / tech debt
- Database tests use PGlite (Postgres 18) and a stand-in for Supabase auth; Supabase runs Postgres 15/17. The SQL avoids version-specific features, but it is unproven there until task 1 is done.
- Edge Function entry points and their `deno.json` import maps point into `packages/` (outside `supabase/functions`). Whether `supabase functions deploy` bundles them must be checked; the fallback is a bundling step.
- Create-user (Owner) needs the Supabase admin API; deferred to M4 (D-031). Roles and profiles are already Owner-only by RLS.
- Location ping ingestion is not built yet (table and RLS only); M3/M8.
- The safety-defect dispatch block waits for the M5 departure checklist (D-059).
- `npm audit`: 4 moderate advisories in build-time deps (via vite-plugin-pwa → workbox-build). Not shipped to phones.
- TypeScript pinned to ~6.0 (typescript-eslint does not support TS 7 yet).
- The background-location limitation of PWAs (Section 5) still applies; M9 only with approval.
