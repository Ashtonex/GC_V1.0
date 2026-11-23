# Game Command V1.0

Operating system for a one-truck distribution business (Mutare, Zimbabwe). Source of truth:
[GC_V1_MASTER_PROMPT.md](GC_V1_MASTER_PROMPT.md). Progress: [STATE.md](STATE.md). Open questions: [DECISIONS.md](DECISIONS.md).

## Layout

```
apps/web            one PWA, two shells: src/driver (mobile, offline-first), src/office (owner/accounts/warehouse)
packages/engine     pure TS financial engine (M1)
packages/schema     Zod schemas, types, permission constants (M1/M2)
supabase/           migrations, Edge Functions, seed (test only), RLS tests (M2)
docs/               owner guides
```

## Commands (Node 22+)

| Command             | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `npm install`       | Install everything                                        |
| `npm run dev`       | Dev server (no service worker) at http://localhost:5173   |
| `npm run build`     | Production build with service worker                      |
| `npm run preview`   | Serve the build at http://localhost:4173                  |
| `npm run lint`      | ESLint                                                    |
| `npm run typecheck` | TypeScript, every workspace                               |
| `npm test`          | Vitest unit tests, every workspace                        |
| `npm run test:e2e`  | Playwright: installable manifest + opens offline          |
| `npm run ci`        | lint + typecheck + unit + build (what CI runs, minus e2e) |

Driver shell: `/`. Office shell: `/office`.

Installing on the pilot phone: [docs/install-pilot-phone.md](docs/install-pilot-phone.md).
