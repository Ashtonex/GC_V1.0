# supabase/

Empty in M0. Filled in from M2. Nothing here is connected to any Supabase project yet (see DECISIONS.md D-002).

| Folder        | Contents (from M2)                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `migrations/` | All schema changes, in order. Never edit a migration once it has been applied.                        |
| `functions/`  | Edge Functions: `ingest-events`, `approve`, `verify`, `close-trip` (more proposed in D-031).          |
| `seed/`       | Section 6 **test constants** only. Seeded in local and staging; **never** in production.              |
| `tests/`      | RLS and permission tests: one test per row of the Section 4B matrix, plus separation-of-duties rules. |
