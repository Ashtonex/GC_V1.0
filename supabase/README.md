# supabase/

Built in M2. Nothing here is connected to any Supabase project yet (see DECISIONS.md D-002).

Tests run with `npx vitest run --project supabase` against PGlite (in-process Postgres) and the stand-in for Supabase auth in `tests/harness/supabase-stub.sql` (P-005). No Docker is needed. `_shared/handlers.ts` holds the Edge Function logic and is tested; `_shared/supabase.ts` is the Deno wiring.

| Folder        | Contents (from M2)                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `migrations/` | All schema changes, in order. Never edit a migration once it has been applied.                        |
| `functions/`  | Edge Functions: `ingest-events`, `approve`, `verify`, `close-trip` (more proposed in D-031).          |
| `seed/`       | Section 6 **test constants** only. Seeded in local and staging; **never** in production.              |
| `tests/`      | RLS and permission tests: one test per row of the Section 4B matrix, plus separation-of-duties rules. |
