# GC V1.0 — STATE
Last updated: 2026-11-23 09:20 (Africa/Harare) by agent session 2
Current milestone: M1 — Financial engine (pure TS)
Status: AWAITING OWNER REVIEW

## Done this session
- M0 approved by the owner (DECISIONS.md M-000) and committed on `main`. M1 work is on branch `m1-financial-engine`.
- `packages/schema`: Zod schemas for money (integer minor units + ISO code; ZiG = `ZWG`), FX rates (decimal strings + source + timestamp), and the 12 trip event types the engine reads (two-sided stock/cash handovers, sale with lines and split payments, debt collection, expense reported/reviewed, payment verification, damage, fuel reading, reversal).
- `packages/engine`:
  - `operational` (device + server, selling prices only): net sales, tenders and change, tender check, expected cash per currency, amounts expected in company accounts, receivables, stock per product, open items on the status ladder, close readiness.
  - `economics` (server only): COGS from frozen snapshots, gross profit, approved / pending / disputed costs, confirmed vs provisional contribution, stock check at cost, exposure (cash and stock kept separate), verdicts.
  - `fx`: exact BigInt rational conversion, no floats.
  - `ledger`: validation, idempotency (same event N times = once), conflicting resubmission error, reversals.
  - Every total carries the ids of the events that produced it (Section 2 #9).
- Section 6 fixtures for Scenarios A, B, B2, C (`packages/engine/src/fixtures/section6.ts`, test-only).
- Filled in the Commands table in CLAUDE.md.
- 8 new OPEN questions (D-041…D-048) for rules the engine had to assume.

## Tests
- Scenarios: A ✔  B ✔  B2 ✔  C ✔  D1–D4 ✘ (M3)  E ✘ (M3)
- Typecheck ✔ / lint ✔ / prettier ✔ / unit ✔ 66 passed (scenarios 32, engine integrity 21, fx 6, schema 2, web 5) / e2e ✔ 3 passed
- Build ✔ — driver shell initial JS 70.9 KB gzipped (budget 250 KB). No UI changes this milestone.

## Next 3 tasks
1. Owner reviews M1 and answers the questions that affect the engine (D-005, D-013, D-018, D-041…D-048).
2. On approval: M2 — Supabase schema and migrations (`trip_events` append-only), auth, roles, device registration.
3. M2: `permissions.ts` + RLS + idempotent `ingest-events` function, with one test per permission-matrix row.

## Blockers / owner decisions needed
- M2 needs a Supabase project (local CLI is enough to start; staging needs the owner's account, D-002) and a Git remote (D-003).
- Engine questions: D-041 (FX rounding), D-042 (handover custody), D-043 (verdict thresholds), D-044 (receivables currency), D-045 (fuel cost), D-046 (rejected payments), D-047 (ZWG code), D-048 (damage in economics).
- Still open from M0: D-001, D-038 (pilot phone check), P-001…P-004.

## Known risks / tech debt
- Engine ids are any non-empty string so fixtures stay readable; M2 ingestion must require UUIDs.
- Multi-currency price lists are refused (D-020): a sale priced in ZiG throws `UnsupportedError` until decided.
- `npm audit`: 4 moderate advisories in build-time deps (via vite-plugin-pwa → workbox-build). Not shipped to phones.
- TypeScript pinned to ~6.0 (typescript-eslint does not support TS 7 yet).
- Background-location limitation of PWAs (Section 5) still applies; M9 only with approval.
- No Git remote yet, so CI has not run on GitHub.
