# GC V1.0 — STATE
Last updated: 2026-11-23 (Africa/Harare) by agent session 3
Current milestone: M2 — Database schema, auth, roles, device registration, RLS, idempotent ingestion
Status: AWAITING OWNER REVIEW (gate passes on in-process Postgres; one run on real Supabase still to do, see Blockers)
Previous: M1 — Financial engine — APPROVED 2026-11-23 (M-001)

## Done this session
- Owner answered D-007 (one active trip per truck), D-011 (who moves each trip step), D-024 (clock check at upload), D-027 (driver phone gets driver powers only). All built in.
- `packages/schema`:
  - `permissions.ts`: the Section 4B matrix as data (29 rows × 4 roles), `allows()` / `bestGrant()` with the D-027 driver-phone rule, and `EVENT_ACTIONS` (which rows may send each event type).
  - `ingest.ts`: upload batch format, strict UUID ids, sale id = event id, clients may never send cost snapshots or `TRIP_STATUS_CHANGED`.
  - New event types: `CUSTOMER_CREATED`, `LOSS_CONFIRMED`, `TRIP_STATUS_CHANGED` (server only).
  - Relative imports now end in `.ts` so the same files run in Deno Edge Functions.
- `supabase/migrations` (4 files):
  - 0001 core tables (Section 4 model + devices, settings, expense limits, quarantine, exceptions, projections, location_pings). `trip_events`, `sale_line_costs`, `product_costs` and `exchange_rates` are append-only by trigger; this applies to every role, the table owner included.
  - 0002 RLS on every table, plus role helpers (Owner needs a two-factor session; driver phone → Driver only; drivers see only their in-progress trip).
  - 0003 `ingest_events`: device check, revoked device → quarantine, clock skew at upload, per-event checks (role, own trip, trip state, separation of duties, limits), duplicates, D3 conflicts, D4 all-or-nothing sale bundles, server-written cost snapshots, duplicate-customer flag, projections, `rebuild_projections`.
  - 0004 `set_trip_state` (D-011), `register_device`, `revoke_device`, `close_trip` (service role only, called after the engine close check).
- `supabase/functions`: `ingest-events`, `approve`, `verify`, `close-trip`. The logic is in `_shared/handlers.ts` (tested); the Deno wiring is in `_shared/supabase.ts` (not yet run, see Blockers).
- `supabase/tests`: PGlite harness (P-005) with a Supabase auth stub; Section 6 test fixtures (test only).

## Tests
- Scenarios: A ✔  B ✔  B2 ✔  C ✔ (engine, M1) · A, B, B2, C via the ingest API = M1 results ✔ (M2) · final states via close-trip: A CLOSED ✔, B CLOSED_WITH_EXCEPTIONS ✔, B2 CLOSED ✔, C CLOSED_WITH_EXCEPTIONS ✔ · D3 ✔ D4 ✔ D2 ✔ at API level · D1, D5 full, E full ✘ (M3, need the sync client)
- Permission matrix: 29/29 rows have an enforcement test (meta-test checks none is missing); separation-of-duties rules 1–4, D-027, Owner two-factor and anon tested. Mutation check: switching off two separation-of-duties rules made 4 tests fail.
- Typecheck ✔ / lint ✔ / prettier ✔ / unit ✔ 182 passed (11 files: engine 59, schema 38, web 5, database + Edge handlers 80) / e2e ✔ 3 passed
- No UI changes this milestone (no 360px / offline UI check needed).

## Next 3 tasks
1. Run the migrations and the database tests once on real Supabase (local CLI with Docker, or a staging project), and run the four Edge Functions in the Deno runtime (`supabase functions serve`). `supabase/config.toml` now exists (Postgres 17, TOTP two-factor on); owner chose to hold M2 approval until this run (2026-11-23).
2. Owner review of M2 and of D-050…D-059, P-005.
3. M3: Dexie outbox + sync client; Scenarios D (D1–D4) and E through a sync test harness.

## Blockers / owner decisions needed
- **Docker Desktop opens but its engine never becomes reachable** (its log reports it could not read a licence file, so it is probably waiting on a dialog such as the service agreement or sign-in). The owner needs to open Docker Desktop and clear that. Then: `supabase start`, `supabase db reset`, `supabase functions serve` (config is ready). Checked again 2026-11-23: no Docker processes running, engine pipe missing. Alternatively, approve a staging Supabase project (D-002).
- New OPEN decisions D-050…D-059 and P-005. The most pressing: D-055 (late-arriving sales, needed by M3) and D-054 (credit over limit).
- Still open: D-002, D-003 (Git remote, so CI has not run on GitHub), D-013, D-018, D-049, D-001, D-038, P-001…P-004.

## Known risks / tech debt
- Database tests use PGlite (Postgres 18) and a stand-in for Supabase auth; Supabase runs Postgres 15/17. The SQL avoids version-specific features, but it is unproven there until task 1 is done.
- Edge Function entry points and their `deno.json` import maps point into `packages/` (outside `supabase/functions`). Whether `supabase functions deploy` bundles them must be checked; the fallback is a bundling step.
- Create-user (Owner) needs the Supabase admin API; deferred to M4 (D-031). Roles and profiles are already Owner-only by RLS.
- Location ping ingestion is not built yet (table and RLS only); M3/M8.
- The safety-defect dispatch block waits for the M5 departure checklist (D-059).
- `npm audit`: 4 moderate advisories in build-time deps (via vite-plugin-pwa → workbox-build). Not shipped to phones.
- TypeScript pinned to ~6.0 (typescript-eslint does not support TS 7 yet).
- The background-location limitation of PWAs (Section 5) still applies; M9 only with approval.
