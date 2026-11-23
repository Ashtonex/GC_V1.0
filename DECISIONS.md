# GC V1.0 — DECISIONS

Format: `ID · date · decision · reason · status (OPEN / APPROVED / REJECTED) · who decided`

Items D-001 to D-040 were found while reading `GC_V1_MASTER_PROMPT.md` in session 1 (2026-11-22). They are
recorded as OPEN and **not resolved**. Where the agent has a suggestion it is labelled "Proposal" and is not
being built on until the owner approves. Items P-xxx are tooling choices the agent made for M0 because the
master prompt left them unspecified; they are easy to reverse and also need owner approval.

---

## A. File and process

**D-001** · 2026-11-22 · The master prompt says it lives at `GC_MASTER_PROMPT.md`; the file in the repo is named `GC_V1_MASTER_PROMPT.md`. Which name is canonical? (Section 9 loop prompt and repo tree reference `GC_MASTER_PROMPT.md`.) · Proposal: rename to `GC_MASTER_PROMPT.md`. Not done, because only the owner edits that file · OPEN · —

**D-002** · 2026-11-22 · M0's definition of done (Section 7) includes "Supabase project, Vercel preview", but the boot prompt (Section 0) lists only repo, CI, tests and the PWA shell, and says not to connect production data. Creating cloud projects needs the owner's accounts, billing and region choice. · Proposal: the owner creates (or approves the agent creating) a **staging** Supabase project and a Vercel project linked to the Git repo; production comes later. M0 stays open until this is done · OPEN · —

**D-003** · 2026-11-22 · No Git remote/host is specified, but CI and Vercel previews need one. GitHub Actions is assumed for CI. · Which Git host and repo name? · OPEN · —

**D-004** · 2026-11-22 · Error monitoring is "Sentry (or equivalent)". Which service, and who owns the account? Needed before M3 (failed-sync visibility) · OPEN · —

## B. Scope and milestone gates

**D-005** · 2026-11-22 · Contradiction: Section 7 says M1 is done when "Scenarios A, B and C pass"; the Section 6 gate table says M1 must pass **A, B, B2, C**. · Proposal: use the stricter list (include B2) · OPEN · —

**D-006** · 2026-11-22 · Section 10 says the costing method is needed "by the time M1 is finalised", but Section 6 says to use a fixed standard cost (labelled "provisional") until the accountant confirms. Can M1 be signed off on standard cost alone? · OPEN · —

**D-007** · 2026-11-22 · "One truck, one active trip at a time" — is the limit one active trip **per truck** or **per organisation**? (Affects a DB constraint.) · **Per truck.** A truck can have one trip between LOADING and RECONCILING (DRAFT is planning and does not count) · APPROVED (2026-11-23, in chat at M2 start) · owner

## C. Trip state machine

**D-008** · 2026-11-22 · Contradiction: `CLOSED` and `CLOSED_WITH_EXCEPTIONS` look like terminal states, but Scenario B says the trip is `CLOSED_WITH_EXCEPTIONS` "until the repair is approved or disputed" and Scenario B2 then reaches `CLOSED`. Is `CLOSED_WITH_EXCEPTIONS → CLOSED` a legal transition once all items are resolved? Can a trip be reopened? · OPEN · —

**D-009** · 2026-11-22 · Scenario B says it stays `CLOSED_WITH_EXCEPTIONS` "until the repair is approved **or disputed**", but Section 6 says a disputed expense is itself an open item. So a dispute would not lead to `CLOSED`. Which is right? · OPEN · —

**D-010** · 2026-11-22 · "Close with exceptions" is **Owner only** (permission matrix), yet Scenario C says the items are "assigned to Accounts". Confirm: the Owner performs the close-with-exceptions, assigning items to Accounts? · OPEN · —

**D-011** · 2026-11-22 · Transitions not defined: who/what moves `DRAFT → LOADING`, `LOADING → AWAITING_ACCEPTANCE`, `DISPATCHED → RETURNED` (driver taps "Returned"? warehouse starts return count? Accounts?) and `RETURNED → RECONCILING`. Location collection stops at `RETURNED`, so this trigger matters · **Split:** Owner/Accounts move DRAFT→LOADING; Warehouse moves LOADING→AWAITING_ACCEPTANCE (loading done); the Driver taps "Returned" for DISPATCHED→RETURNED (Owner/Accounts may do it if the phone is dead); Owner/Accounts move RETURNED→RECONCILING · APPROVED (2026-11-23, in chat at M2 start) · owner

**D-012** · 2026-11-22 · `business_date` is "set at dispatch". In which time zone (assume Africa/Harare, UTC+2)? · OPEN · —

## D. Financial rules

**D-013** · 2026-11-22 · Possible double count of fuel. "Trip direct costs = approved trip expenses + fuel consumption cost (approximate) + allowances". In Scenario A the fuel purchase of USD 50 is an approved expense **and** fuel is consumed (gauge ½ → ½). The expected direct costs count fuel once (USD 50). Rule needed: is fuel cost = purchases (expense), or = litres consumed × price (with purchases excluded from expenses), or something else? With a different opening/closing gauge the two methods give different results · OPEN · —

**D-014** · 2026-11-22 · How is "fuel consumption" calculated from gauge fractions (½)? Needs tank capacity per truck, and a fuel price per litre. Neither is in the data model · OPEN · —

**D-015** · 2026-11-22 · Allowances: in Scenario A the USD 20 allowance is "a trip expense" paid by the office. Is it recorded as an expense (and does it need approval by a second person), or as its own type? Who records it? · OPEN · —

**D-016** · 2026-11-22 · Contradiction: the `expenses` table has `paid_from[driver_cash|office]`, but Section 6 adds a third value, `unpaid` (owed to a supplier). Also the table has one `status` column while Section 6 says reported / paid-from / approval are three independent facts · OPEN · —

**D-017** · 2026-11-22 · Damaged stock: the stock check includes "Damaged", but the economics never say whether damaged stock (at cost) is a trip cost, a separate loss line, or nothing until confirmed. · OPEN · —

**D-018** · 2026-11-22 · Scenario C reports "2 open differences ($35.00 exposure at cost/cash)", adding a cash shortfall (USD 20) to a stock difference at cost ($15). Section 1 says the four truths must never be merged into one number. Should the report show the two exposures separately? · OPEN · —

**D-019** · 2026-11-22 · Scenario B says "Same departure as A. Only S1 and S4 happen", but its numbers ($76 approved costs, USD 224 expected cash) assume the fuel USD 50 and toll USD 6 expenses from A also happen. Confirm the fuel and toll expenses are part of B · OPEN · —

**D-020** · 2026-11-22 · Price list currency: are selling prices held in USD only (ZiG derived via FX), or does the price list carry separate ZiG prices? `sales.currency` is a single value, while S2 is paid partly in ZiG · OPEN · —

**D-021** · 2026-11-22 · Change given in a different currency from the tender (e.g. customer pays USD, gets change in ZiG). Allowed? If so, which FX rate? · OPEN · —

**D-022** · 2026-11-22 · Receivables currency: are customer balances always USD? Scenario A's "Customer E −$75" implies E had an opening balance from before GC. How are opening balances loaded (not mentioned in M4 scope)? · OPEN · —

**D-023** · 2026-11-22 · Credit limits offline: the device needs each customer's current balance to enforce "within cached limit". Is that balance cached on the device, and how are several offline credit sales to one customer counted against it? · OPEN · —

**D-024** · 2026-11-22 · Clock-skew rule is ambiguous for offline events. "Flag events whose device clock differs from server time by more than 10 minutes" — an offline sale synced 6 hours later always has `received_at − occurred_at` of 6 h. Proposal: measure skew as (device clock at upload − server clock at upload) per batch, and apply it to every event in that batch, rather than comparing `occurred_at` with `received_at` · **Compare at upload** (the proposal) · APPROVED (2026-11-23, in chat at M2 start) · owner

**D-025** · 2026-11-22 · FX: Section 10 says the Trip Rate vs daily rate decision is needed by M4, but the M1 engine must convert ZiG to USD (S2: ZiG 2,700 = $100). Proposal: M1 engine takes the rate as an input on each payment, so either rule can be plugged in later; fixtures use the TEST rate 27.00 · OPEN · —

## E. Roles, permissions and devices

**D-026** · 2026-11-22 · Non-negotiable 1 mentions "an office-side debt collection" not belonging to a trip, but the permission matrix lets only the Driver record collections (own DISPATCHED trip only). Who records office-side collections? · OPEN · —

**D-027** · 2026-11-22 · Roles can be combined, but "drivers never see costs". If one person is both Driver and Owner/Accounts and uses one phone, the device would receive costs. Rule needed: does the Driver role always win on a driver-registered device, or are Driver and office roles kept on separate devices/logins? · **Driver wins on a driver phone:** a request made from a registered driver device only ever gets driver data and driver powers, whatever other roles the person holds. Office work needs an office sign-in on another device · APPROVED (2026-11-23, in chat at M2 start) · owner

**D-028** · 2026-11-22 · Office screens run in the same PWA. Do office devices cache data (including costs) in IndexedDB for offline use, or are office screens online-only? (The "no costs on the device" rule is written for driver phones.) · OPEN · —

**D-029** · 2026-11-22 · Contradiction: permission matrix says the Driver may "view live location / trail — own only", but Section 3 says the driver app shows **no map** in V1. Proposal: driver sees no map and no trail in V1; the matrix row means the server allows the driver to read their own pings only · OPEN · —

**D-030** · 2026-11-22 · Driver corrections: "own unsynced draft only". Is an unsynced draft an event in the append-only ledger? Proposal: a draft (sale not yet completed) is not an event; once "Sale saved" commits locally it is an event and can only be corrected by a new event, even before sync · OPEN · —

**D-031** · 2026-11-22 · Edge Functions list (ingest-events, approve, verify, close-trip) has no function for revoke-device, confirm-loss, create-user or merge-customer, although these are server-side role-checked actions. Proposal: add them as needed in M2 · M2 update: `ingest-events`, `approve`, `verify`, `close-trip` built; device registration/revocation are role-checked database functions; confirm-loss goes through ingestion (`LOSS_CONFIRMED`, Owner only); create-user (needs the Supabase admin API) is deferred to M4 back office · OPEN · —

**D-032** · 2026-11-22 · Scenario E: "events it recorded before revocation are quarantined". Since an offline device does not know it was revoked, all events uploaded by a revoked device go to quarantine, whatever their `occurred_at`. Confirm · OPEN · —

## F. Driver app and location

**D-033** · 2026-11-22 · Manifest orientation: Section 4C asks for "a portrait orientation lock for the driver area", but there is one PWA with one manifest, and office screens are desktop/tablet. A manifest `orientation` applies to the whole installed app. Proposal: no manifest lock; lock portrait in the driver shell at runtime where the browser allows (`screen.orientation.lock` only works in fullscreen on most Android browsers) plus a "rotate your phone" overlay in landscape. Alternative: two separate installable PWAs (two manifests/scopes) · OPEN · —

**D-034** · 2026-11-22 · `location_pings.source` includes `manual`. What is a manual ping, and who records it? · OPEN · —

**D-035** · 2026-11-22 · App updates are applied "only when no events are pending sync". If sync is broken for days, a fix for the sync bug could never be applied. Proposal: allow Owner to force an update after the outbox has been exported/backed up locally · OPEN · —

**D-036** · 2026-11-22 · Lost-phone exposure says "selling prices" are cached, and "no other trips". Are the customer list and credit balances (D-023) also acceptable to cache? · OPEN · —

**D-037** · 2026-11-22 · Selling units (Section 10, needed by M4): whole cases/bales only, or single units too? Affects `qty_base_units` and pack-size conversion · OPEN · —

**D-038** · 2026-11-22 · Pilot phone make/model and Android/Chrome version are unknown. Needed for the M0 install check, the 250 KB budget test and M8 battery-saver testing · OPEN · —

**D-039** · 2026-11-22 · Offline PIN: after "Five wrong PIN attempts lock the app until an online sign-in", is the local unsynced outbox kept (and uploaded after sign-in)? Proposal: yes, never discard queued events · OPEN · —

**D-040** · 2026-11-22 · Section 2 #10 status ladder has an implicit order but no rule on who moves items between the middle steps (e.g. Reconciliation difference → Unresolved shortage), or when (time-based?). · OPEN · —

## G. Raised during M1 (engine). The engine follows the Section 6 numbers; these are the rules it had to assume where Section 6 is silent. Each is isolated in one place so it is cheap to change.

**D-041** · 2026-11-23 · FX rounding. The engine converts with exact fractions; an inexact result is rounded **half away from zero** to the cent. When checking that a sale's payments add up to its total, each inexact conversion may be off by 1 cent. Owner/accountant to confirm the rounding rule (`packages/engine/src/fx.ts`, `operational.ts`) · APPROVED (2026-11-23, as implemented in M1) · owner

**D-042** · 2026-11-23 · Two-sided handover custody. Engine rule: custody follows the **receiver's** count; if the issuer's count differs, both are kept and a "handover discrepancy" open item is raised. A **disputed** handover moves nothing into custody until it is resolved. Confirm · APPROVED (2026-11-23, as implemented in M1) · owner

**D-043** · 2026-11-23 · Verdict thresholds. Engine: `loss` if confirmed contribution < 0; `provisional loss` if confirmed ≥ 0 but provisional < 0; `profitable` only if both are > 0; otherwise `break even`. Confirm · APPROVED (2026-11-23, as implemented in M1) · owner

**D-044** · 2026-11-23 · Receivables are kept **per currency of the payment** (credit in USD raises a USD balance; a ZiG collection would reduce a ZiG balance, not USD). Linked to D-022 · APPROVED (2026-11-23, as implemented in M1) · owner

**D-045** · 2026-11-23 · Fuel cost in M1 = **approved fuel purchase expenses only**. Gauge readings are reported as approximate information and add no cost. This matches Scenario A but leaves D-013/D-014 open · APPROVED (2026-11-23, as implemented in M1) · owner

**D-046** · 2026-11-23 · Unverified or **rejected** EcoCash/swipe/transfer payments are open items that block `CLOSED` (Scenario A implies verification is required). A rejected payment is not put on the loss ladder. Should a rejected payment become a cash shortfall for the driver, or a receivable from the customer? · APPROVED (2026-11-23, as implemented in M1) · owner

**D-047** · 2026-11-23 · ZiG is stored with ISO code **`ZWG`** (Section 2 #4 requires an ISO code) and shown as "ZiG" on screen. Confirm · APPROVED (2026-11-23, as implemented in M1) · owner

**D-048** · 2026-11-23 · Damaged stock (D-017): the engine counts it in the stock check at cost but it does **not** change contribution. Confirm or decide where damage goes in the economics · APPROVED (2026-11-23, as implemented in M1) · owner

---

**D-049** · 2026-11-23 · Follow-up to D-046 (approved: a rejected non-cash payment stays an open item, not on the loss ladder). Still to decide: when a rejected payment is finally resolved, does it become a cash shortfall for the driver or a receivable from the customer? Needed by M7 · OPEN · —

## H. Raised during M2 (database, permissions, ingestion). Each is an interim rule, isolated in one place, and easy to change.

**D-050** · 2026-11-23 · Office-paid trip expenses (e.g. the Scenario A driver allowance). The matrix says only the Driver reports trip expenses, but Scenario A has an office-paid allowance. Interim: Owner/Accounts may record an expense **only with `paid_from = office`**; it still needs a second person to approve it. Linked to D-015 (`check_event`, 0003 migration) · OPEN · —

**D-051** · 2026-11-23 · "A driver sees only … its customers". No link between customers and a trip/route exists, and the driver must pick existing customers to sell to. Interim: a driver with a trip in progress can read the organisation's active (unmerged) customers, including credit limits. Linked to D-036 · OPEN · —

**D-052** · 2026-11-23 · Who records damaged stock, and when. Interim: the trip driver while DISPATCHED, or Warehouse at return (RETURNED/RECONCILING) · OPEN · —

**D-053** · 2026-11-23 · A sale line priced differently from the trip's price list (e.g. the price list changed after the phone cached it). Interim: the sale is **accepted** and a `price_mismatch` exception goes to Accounts. A real sale is never dropped. An explicit discount above the Owner's limit is still **rejected** · OPEN · —

**D-054** · 2026-11-23 · Credit over the limit, or a customer with no limit set. The phone enforces its cached limit (M6); the server cannot "undo" goods already handed over. Interim: **accept** and raise `credit_over_limit` for Accounts. Linked to D-023 · OPEN · —

**D-055** · 2026-11-23 · Late arrivals. If the Owner marks a trip RETURNED while the phone is still offline, sales recorded before that arrive after the trip has left DISPATCHED. Today they are **rejected** (kept in full as a visible exception, never lost). Should a sale whose `occurred_at` is before `returned_at` be accepted instead? Needed by M3 · OPEN · —

**D-056** · 2026-11-23 · Data-model change: the unit cost snapshot is stored in a separate append-only table `sale_line_costs`, not as a column on `sale_lines` (Section 4 model). Reason: drivers may read their own sale lines, and Postgres RLS cannot hide one column, so a cost column would leak to the phone (Section 4B rule 5) · OPEN · —

**D-057** · 2026-11-23 · Until the Owner sets an Accounts expense-approval limit for a currency, Accounts can mark evidence reviewed but cannot approve or dispute; those go to the Owner ("Needs Owner"). The limit itself is a Section 10 decision (M6). Tests use USD 100.00 · OPEN · —

**D-058** · 2026-11-23 · Time windows used by the server: stock issue only while LOADING; cash floats while LOADING or AWAITING_ACCEPTANCE; driver expenses, sales, collections, new customers only while DISPATCHED; fuel readings AWAITING_ACCEPTANCE→RETURNED; returns and cash handover in RETURNED/RECONCILING; losses in RECONCILING / CLOSED_WITH_EXCEPTIONS. `business_date` uses Africa/Harare (the D-012 proposal). Confirm · OPEN · —

**D-059** · 2026-11-23 · Dispatch currently checks the stock issue and a driver response to every handover. The "safety-critical defect blocks dispatch" check arrives with the departure checklist events in M5. Confirm this is acceptable for M2 · OPEN · —

**P-005** · 2026-11-23 · Database tests run in **Vitest against PGlite** (real Postgres 18 compiled to WebAssembly, in-process) plus a small stand-in for Supabase's `auth` schema and roles, instead of pgTAP on a Docker stack. Reason: Docker was not available, and this also runs in CI with no Docker. Risk: Supabase runs Postgres 15/17 and its real `auth` setup; the same migrations and tests must still be run once on local Supabase or staging before M3 is signed off · OPEN (agent choice) · agent

---

## M. Milestone sign-offs

**M-001** · 2026-11-23 · **M1 approved** by the owner: Scenarios A, B, B2, C pass as pure engine tests; D-041…D-048 approved as implemented · APPROVED · owner

**M-000** · 2026-11-23 · **M0 approved** by the owner. Lint, typecheck, unit, build and Playwright offline tests pass locally. Carried forward, still open: pilot-phone airplane-mode check (D-038), Git remote / CI on a host (D-003), staging Supabase + Vercel preview (D-002) · APPROVED · owner

---

## P. Tooling choices made for M0 (unspecified in master prompt; easy to change)

**P-001** · 2026-11-22 · Package manager: **npm workspaces** (Node 24 / npm 11 already installed; no extra tool). Alternative: pnpm · OPEN (agent choice, needs owner OK) · agent

**P-002** · 2026-11-22 · CI: **GitHub Actions** running lint, typecheck, unit tests, build and a Playwright offline smoke test (depends on D-003) · OPEN (agent choice) · agent

**P-003** · 2026-11-22 · PWA: **vite-plugin-pwa** (Workbox `generateSW`, `registerType: prompt`) so the "Update available" prompt can later be gated on an empty outbox (Section 4 rule) · OPEN (agent choice) · agent

**P-004** · 2026-11-22 · Placeholder app icons are generated by a script (`apps/web/scripts/make-icons.mjs`). Real branding/icons to be supplied by the owner · OPEN · agent
