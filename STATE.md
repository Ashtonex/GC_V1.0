# GC V1.0 — STATE
Last updated: 2026-11-23 09:00 (Africa/Harare) by agent session 1 (boot)
Current milestone: M0 — Repo, tooling, CI, Supabase project, Vercel preview, PWA shell
Status: APPROVED by owner 2026-11-23 (cloud items carried forward)

## Done this session
- Read the master prompt; recorded 40 open questions/contradictions (D-001…D-040) and 4 tooling choices (P-001…P-004) in DECISIONS.md, all OPEN.
- npm-workspaces monorepo: `apps/web`, `packages/engine`, `packages/schema`, `supabase/` (empty placeholders), `docs/`.
- Driver PWA shell (`/`) and office shell (`/office`): React 19 + TS + Vite 8 + Tailwind 4 + vite-plugin-pwa (Workbox). Installable manifest (standalone, 192/512/maskable icons, theme colour), whole shell precached, "Update available" prompt (registerType `prompt`), sync status pill, bottom bar with safe-area padding, 44px+ targets. No map in the driver app.
- Tooling: ESLint (with a `parseFloat`/`Math.round` ban in engine/schema), Prettier, TypeScript strict, Vitest across workspaces, Playwright e2e against the production build.
- GitHub Actions CI: lint, typecheck, unit, build, Playwright offline smoke test.
- Owner guide: `docs/install-pilot-phone.md` (USB port-forwarding install today; Vercel HTTPS later).
- No financial rules, no production data, no map work (as instructed).

## Tests
- Scenarios: A ✘  B ✘  B2 ✘  C ✘  D1–D4 ✘  E ✘  (not started — M1/M3; placeholders as `it.todo`)
- Typecheck ✔ / lint ✔ / unit ✔ (8 passed, 4 todo) / e2e ✔ (3 passed: installable manifest, reopens offline incl. unvisited `/office`, no map requests)
- Build: initial JS 70.9 KB gzipped (budget 250 KB). Checked at 360px width in the browser pane.

## Next 3 tasks
1. Owner runs the airplane-mode check on the pilot phone (docs/install-pilot-phone.md) and reports phone model (D-038).
2. Finish M0 cloud items once approved: Git remote (D-003), staging Supabase project + Vercel preview (D-002), then confirm CI runs green on the remote.
3. On owner approval of M0: start M1 by writing Scenario A/B/B2/C fixtures as failing engine tests.

## Blockers / owner decisions needed
- D-002 / D-003: Supabase staging project, Vercel project and Git host — needs owner accounts/approval. M0 is not fully "done" until these exist.
- D-005, D-006, D-013, D-019, D-025 should be answered before M1 (they change engine fixtures).
- D-001: canonical file name of the master prompt.
- P-001…P-004: tooling choices to approve.

## Known risks / tech debt
- `npm audit`: 4 moderate advisories in build-time deps (minimatch via workbox-build, pulled by vite-plugin-pwa 2.0). Build-only, not shipped to phones; recheck when vite-plugin-pwa updates.
- TypeScript pinned to ~6.0 because typescript-eslint does not support TS 7 yet.
- Locally, e2e uses installed Google Chrome (`channel: 'chrome'`); CI uses Playwright Chromium.
- Background location limitation of PWAs (Section 5) still applies; M9 only with approval.
- M0 committed on `main` (no remote yet).
