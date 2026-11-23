# GAME COMMAND V1.0 — MASTER BUILD PROMPT (LOOP EDITION)

> **How to use this file**
> 1. Put this file in the root of the repository as `GC_MASTER_PROMPT.md`.
> 2. On the first session, paste **Section 0 (Boot Prompt)** into your coding agent (Cursor, Claude Code, BridgeAgent, etc.).
> 3. On every following session, paste **Section 9 (Loop Prompt)**. The agent reads this file plus `STATE.md` and continues from where it stopped.
> 4. Only the owner edits Sections 1–6. The agent edits `STATE.md`, `DECISIONS.md` and the code. If the agent thinks a rule here is wrong, it records a proposal in `DECISIONS.md` and does not quietly work around the rule.

---

## SECTION 0 — BOOT PROMPT (paste on the first session only)

```
You are the lead engineer building Game Command V1.0 (GC V1.0).
Read GC_MASTER_PROMPT.md in full before writing any code. It is the source of truth.

Your first session tasks:
1. Restate in your own words, in under 300 words: the product, the V1 scope, the 10 non-negotiables (Section 2), and what is out of scope.
2. List every ambiguity or contradiction you find in this file. Do not resolve them yourself; record them in DECISIONS.md as OPEN.
3. Create the repository skeleton for Milestone M0 (Section 7): repo structure, CI, test setup and an installable driver PWA shell. Create STATE.md using the template in Section 8.
4. Explain how the owner can install the shell on the pilot Android phone and confirm it reopens in airplane mode.
5. Stop and report. Do NOT implement financial rules, connect production data, or start any map work in this session. Do not begin M1 until the owner confirms.

Operating rules for every session are in Section 9. Follow them exactly.
```

---

## SECTION 1 — PRODUCT CONTEXT

**Product:** Game Command (GC), an operating system for a truck-based distribution business in Zimbabwe.
**Version:** V1.0, for **one truck** operating live (real stock, real cash, real customers, real roads).
**Operator base:** Mutare, Zimbabwe. Routes include long-haul runs (e.g. Mutare–Harare) and city/rural runs. Connectivity is intermittent.

**Product promise (the selling point V1 must prove):**
> By the time the truck is back, the owner knows whether the trip made money, and where every dollar, litre and case went, in USD and ZiG.

**The central operating loop:**
`Prepare → Load → Accept → Dispatch → Sell → Collect → Return → Reconcile → Close`

**The four truths the system must keep separate (never merge them into one number or one colour):**
| Truth | Question it answers |
|---|---|
| Economic | Did the trip make money? What did it cost? |
| Physical | What stock, fuel and cash existed, moved, was sold, returned or handed over? |
| Evidentiary | What is verified, reported, disputed or unknown? |
| Management | What needs a decision, who must act, by when? |

A trip can be profitable with open discrepancies. A trip can lose money with everything accounted for. The system must be able to show both cases at once.

---

## SECTION 2 — NON-NEGOTIABLES

1. **The trip is the central record.** Every sale, payment, expense, stock movement, handover and location ping belongs to a trip (or is explicitly marked as not belonging to one, e.g. an office-side debt collection).
2. **Append-only event ledger.** History is never edited or deleted. Corrections are new events (reversal, replacement or adjustment) with a reason and the authorised user who made them.
3. **Two-sided handovers.** Every transfer of stock, cash or fuel records the issuer's quantity and the receiver's quantity separately. The receiver can choose **Accept**, **Accept with discrepancy** or **Dispute**. The system never overwrites one side with the other.
4. **Money is never a float.** Store amounts as integer minor units (cents) together with an ISO currency code. Store FX rates as decimal strings together with source and timestamp. All arithmetic is in integers or decimal libraries.
5. **Currency accountability is preserved.** USD and ZiG are counted and reconciled separately. Consolidated USD figures may be *displayed*, but the original currency, amount and rate on every transaction always stay visible.
6. **One sale, many payments.** A sale can be split across cash USD, cash ZiG, EcoCash, swipe/card, bank transfer and credit (balance owed). Change given is recorded on the payment.
7. **Cost is frozen at the moment of sale.** Each sale line stores the unit cost snapshot used for COGS. Later cost changes never rewrite historical trip profit.
8. **Offline-first driver app.** The driver can complete a whole trip with no signal. Events get client-generated UUIDs and sync idempotently: syncing the same event five times must create exactly one record.
9. **Every number is traceable.** Every figure on the trip-close report can be drilled down to the events that produced it.
10. **No accusation without evidence.** Use the status ladder *In custody → Handover pending verification → Reconciliation difference → Unresolved shortage → Confirmed loss*. Only an authorised user can move an item to "Confirmed loss".

---

## SECTION 3 — V1.0 SCOPE

### In scope
- One organisation, one truck, one active trip at a time (the data model must still support more trucks later; never hard-code "truck 1").
- Roles: **Owner**, **Accounts/Office**, **Warehouse**, **Driver**.
- Product catalogue with pack sizes, a price list, and cost per product.
- Trip creation, loading (warehouse side), departure acceptance (driver side) and dispatch authorisation.
- Departure checklist on one screen: vehicle inspection, opening fuel level/odometer, cash floats received (per currency), stock acceptance, device readiness. Safety-critical defects block dispatch.
- Driver POS: sell from truck stock, mixed tender, change, credit sales within cached limits, receipt (on-screen plus shareable image/PDF/WhatsApp text).
- Customer creation during a sale (name, phone, location pin, business type). Duplicate detection runs on sync.
- Debt collections recorded separately from sales.
- Trip expenses: report, attach a photo of the receipt, then *Reported → Evidence reviewed → Approved / Disputed*.
- Fuel: opening level, litres added (issued or purchased), closing level and odometer readings. Consumption assigned to the trip is calculated and **flagged as approximate**.
- Returns: two-sided count of the stock that comes back. Damage is recorded as its own event type.
- Cash handover at trip end, per currency and per tender type, two-sided.
- Payment verification by Accounts for EcoCash, swipe and transfer references.
- **Trip-close report** (the V1 executive view): Economics, Accountability, Data confidence, Open actions.
- **Live location tracking** while the app is open and online (Section 5).
- **Owner live view:** a map showing the truck's last known position with its freshness, trip status, provisional sales, and the cash and stock currently in custody. **The map is shown only on Owner/Accounts screens. The driver app shows no map in V1.** It records coordinates silently, which saves the driver's mobile data and map API calls.
- Audit trail of every event, approval, override and adjustment.

### Out of scope for V1 (do not build; propose in DECISIONS.md if you think something is needed)
Predictive analytics, route optimisation, advanced dashboards, commissions, multi-truck scheduling, payroll, a full general ledger, supplier purchasing, ZIMRA fiscal device integration (see Section 6), and background GPS when the app is closed.

---

## SECTION 4 — TECHNICAL ARCHITECTURE

### Stack (default; changes require a DECISIONS.md entry approved by the owner)
| Layer | Choice | Reason |
|---|---|---|
| Frontend | React + TypeScript + Vite, built as a **PWA** | One codebase for phone and desktop, installable, works offline |
| Native wrapper (later loop) | Capacitor (Android) | Only if foreground tracking proves insufficient; see Section 5 |
| Local storage | IndexedDB via Dexie | Offline event store and cache |
| Offline/sync | Service worker (Workbox) plus an **outbox pattern** | Queued events, retries, idempotent upload |
| Backend | Supabase (Postgres, Auth, Row Level Security, Edge Functions, Storage for receipt photos) | Managed, SQL-first, fits the event ledger |
| Hosting | Vercel | Simple deploys and preview environments |
| Maps | Behind a `MapProvider` interface. Default: Google Maps JavaScript API. Fallback: MapLibre GL with a commercial tile provider | Avoid lock-in; control cost |
| Testing | Vitest (unit, financial engine), Playwright (end-to-end, offline simulation) | The financial engine must be test-driven |
| UI kit | Tailwind CSS + shadcn/ui, vaul for bottom sheets, @tanstack/react-virtual for long lists, TanStack Query for server reads | Native-feeling mobile UI (Section 4C) |
| Validation | Zod schemas shared by client, engine and Edge Functions | One definition of each event |
| Error monitoring | Sentry (or equivalent), including failed syncs | Field failures must be visible |

**Why Vite and not Next.js:** GC is an offline-first app. Nearly every screen must work with no server, so server rendering adds complexity (service worker plus App Router caching) without benefit. A Vite single-page PWA is simpler and faster on cheap Android phones. If the owner prefers Next.js, record it in DECISIONS.md. Next.js is then used in static/client mode for the driver area, and every rule in this file still applies.

### Repository structure
```
/apps/web                 one PWA, two role-based shells
   /src/driver            driver experience (mobile-first, offline)
   /src/office            owner / accounts / warehouse experience (desktop + tablet)
   /src/shared            components, hooks, map provider, sync client
/packages/engine          pure TS financial engine + scenario tests
/packages/schema          Zod event/command schemas, shared types, permission constants
/supabase
   /migrations            all schema changes, in order; never edit an applied migration
   /functions             Edge Functions: ingest-events, approve, verify, close-trip
   /seed                  test constants from Section 6
   /tests                 RLS and permission tests (pgTAP or SQL test scripts)
/docs                     owner guides (maps setup, consent form, how to run a trip)
GC_MASTER_PROMPT.md  STATE.md  DECISIONS.md
```

### Authentication and devices
- **Office users** (Owner, Accounts, Warehouse) sign in with email and password through Supabase Auth. Two-factor authentication is required for Owner.
- **Drivers** sign in online once with credentials the Owner creates. They then set a **4–6 digit local PIN** to unlock the app offline. The session refresh token is stored on the device; the PIN never leaves the device.
- **Device registration:** each driver phone is registered (`devices` table) the first time it signs in. The Owner can revoke a device, which ends its session at the next sync.
- **Lost or broken phone:** events not yet synced are lost. To limit this, the app syncs whenever it has signal and warns the driver when more than 20 events or 30 minutes are unsynced. The owner view shows "last sync" for each device.
- **What a lost phone still exposes while offline:** anyone with the PIN can read what is cached on it: the current trip, its customers, selling prices and the trip's own events. No costs, margins or other trips are ever on the device. Five wrong PIN attempts lock the app until an online sign-in.
- **Revocation** takes effect at the phone's next contact with the server: its token is rejected and no further events are accepted from that device. Events it recorded before revocation are quarantined for Accounts to review, not silently accepted. **Test this before the pilot** (Scenario E).
- No self-registration. Only Owner creates users and assigns roles.

### Environments and operations
- Three environments: **local** (Supabase CLI), **staging** (separate Supabase project + Vercel preview), **production**. Real trips run only in production; test scenarios run in local and staging.
- Schema changes go only through migrations in the repo, applied to staging first.
- Check the Supabase plan's backup coverage before go-live, and run a scripted restore test once before the pilot.
- App updates: the service worker shows "Update available". Updates are applied **only when no events are pending sync and no sale is in progress**, never mid-sale.

### Architecture rules
- **The financial engine is a pure TypeScript module** (`/packages/engine`) with no UI and no database calls. It takes events and returns results. It has **two separate outputs**:
  - **Operational totals** (`engine.operational`): sales by tender and currency, change given, expected cash in custody per currency, receivables created/collected, stock on truck in units. It uses **selling prices only**, runs on the driver's device and on the server, and never needs costs.
  - **Trip economics** (`engine.economics`): COGS, gross profit, direct costs, contribution, stock at cost. It runs **on the server only**, because the device never receives costs.
- **Cost version for offline sales:** COGS uses the product cost effective at the sale's `occurred_at` (device time), and the server writes that snapshot onto the sale line at ingestion. If the event is flagged for clock skew (> 10 min), the server uses the cost effective at `received_at` and raises a review item for Accounts. A cost change between the sale and the sync must never silently change a trip's result. Later cost edits never rewrite existing snapshots.
- The engine must pass the acceptance fixtures in Section 6 before any screen that displays money is built.
- **The event table is the source of truth.** Balances (truck stock, cash in custody, receivables) are derived projections. Projections can be rebuilt from events at any time; write a script that does this and test it.
- **Row Level Security on every table.** A driver sees only their assigned trip, its customers and its products. Accounts cannot edit events, only add verification events.
- **Server time and device time are both stored.** `occurred_at` (device clock) and `received_at` (server clock). Flag events whose device clock differs from server time by more than 10 minutes.
- **Never trust the client for approvals.** Approval, verification and loss confirmation happen through server-side functions that check the user's role.

### Core data model (minimum; extend through DECISIONS.md)
```
organizations, users, user_roles
trucks, routes
products (sku, name, base_unit, pack_size, active)
product_costs (product_id, unit_cost_minor, currency, effective_from, method)   -- costing method set by accountant
price_lists, price_list_items
customers (id uuid client-generated, name, phone, lat, lng, type, created_on_trip_id, merged_into_id)
exchange_rates (from_ccy, to_ccy, rate_decimal, source, effective_at, entered_by)
trips (id, truck_id, driver_id, route_id, state, planned_date, business_date)
trip_events (id uuid, trip_id, type, payload jsonb, actor_id, device_id,
             occurred_at, received_at, reverses_event_id, reason, status)
sales (id, trip_id, customer_id, total_minor, currency)            -- projection of SALE events
sale_lines (sale_id, product_id, qty_base_units, unit_price_minor, unit_cost_snapshot_minor)
payments (id, sale_id|collection_id, tender, currency, amount_minor,
          change_minor, fx_rate_decimal, fx_rate_id, reference, verification_status)
handovers (id, trip_id, kind[stock|cash|fuel], item_ref, issuer_id, issuer_qty,
           receiver_id, receiver_qty, response[accept|accept_discrepancy|dispute], status)
expenses (id, trip_id, category, amount_minor, currency, paid_from[driver_cash|office],
          receipt_photo_path, status)
location_pings (see Section 5)
```

### Trip state machine
`DRAFT → LOADING → AWAITING_ACCEPTANCE → DISPATCHED → RETURNED → RECONCILING → CLOSED | CLOSED_WITH_EXCEPTIONS`
- `DISPATCHED` requires: the warehouse issue is recorded, the driver has responded to every handover, no safety-critical defect is open, and an authorised user has approved dispatch.
- `CLOSED` requires zero open differences. Otherwise the trip can only move to `CLOSED_WITH_EXCEPTIONS`, with every open item assigned an owner and a due date.
- A trip can span several days. `business_date` is set at dispatch and does not change.

### Offline rules
| Allowed offline | Restricted or flagged offline |
|---|---|
| Open the assigned trip, departure checks, sales at cached prices, payments, new customers, expenses, returns, local stock movements, location buffering | Credit beyond the cached limit, price overrides, merging duplicate customers, approvals, loss confirmation |

- The UI always shows sync status: **Synced / X events pending / Last sync HH:MM**.
- The owner view always shows data freshness: **Live / Partially synced / Stale (last update N min ago)**.
- If the app is killed before syncing, no event may be lost. Test this.

---

## SECTION 4B — ROLES AND PERMISSIONS

### Roles
| Role | Who | Purpose |
|---|---|---|
| **Owner** | Business owner | Full visibility; sets policy, prices, credit limits; final approvals; confirms losses |
| **Accounts** | Office / bookkeeper | Cash issue and receipt, payment verification, expense review, FX rates, reconciliation, trip closure |
| **Warehouse** | Storekeeper / loader | Issues stock to the truck, counts returned stock |
| **Driver** | Driver / salesperson on the truck | Accepts resources, sells, collects, reports expenses, hands back cash and stock |

One person can hold several roles (common in a small business). The **separation-of-duties rules** below still apply to every single action.

### Permission matrix
✔ = allowed · ◐ = allowed with limits · — = not allowed

| Action | Owner | Accounts | Warehouse | Driver |
|---|---|---|---|---|
| Create users, assign roles, revoke devices | ✔ | — | — | — |
| Products and pack sizes | ✔ | ✔ | view | view (own trip) |
| Set selling prices / price list | ✔ | — | — | view (cached) |
| Set product costs / costing method | ✔ | ✔ | — | **never sees cost** |
| Enter daily FX rate | ✔ | ✔ | — | view |
| Set customer credit limits | ✔ | — | — | — |
| Create customer | ✔ | ✔ | — | ✔ (during a sale on own trip) |
| Edit / merge customers | ✔ | ✔ | — | — |
| Create / plan trip | ✔ | ✔ | — | — |
| Record stock issue to truck | — | — | ✔ | — |
| Issue cash float / fuel money | ✔ | ✔ | — | — |
| Accept / dispute handovers at departure | — | — | — | ✔ (own trip) |
| Approve dispatch | ✔ | ✔ | — | — |
| Record sales, payments, collections | — | — | — | ✔ (own DISPATCHED trip only) |
| Discount / price override | ✔ | — | — | ◐ off by default; only within an Owner-set % limit if enabled |
| Credit sale | — | — | — | ◐ within customer's cached limit |
| Report trip expense | — | — | — | ✔ |
| Approve / dispute expense | ✔ (any amount) | ◐ (up to Owner-set limit) | — | — |
| Verify EcoCash / swipe / transfer | ✔ | ✔ | — | — |
| Count returned stock | — | — | ✔ | ✔ (both sides required) |
| Receive cash handover | ✔ | ✔ | — | hands over |
| Record correction / reversal event | ✔ | ✔ (with reason) | ◐ own stock events, with reason | ◐ own unsynced draft only; after sync, request a correction |
| Mark "Confirmed loss" | ✔ | — | — | — |
| Close trip (`CLOSED`) | ✔ | ✔ | — | — |
| Close with exceptions | ✔ | — | — | — |
| View live location / trail | ✔ | ✔ | — | own only |
| View trip-close report incl. margin | ✔ | ✔ | — | — |
| View own trip summary (sales, cash expected, stock on truck) | — | — | — | ✔ (no cost or margin) |
| View audit log | ✔ | ✔ | — | — |

### Separation-of-duties rules (enforced on the server, not just hidden in the UI)
1. **No self-acceptance:** the issuer of a handover and its receiver must be different users.
2. **No self-approval, applied per item:** a user cannot approve, verify or accept the *specific item* they recorded or issued (an expense, a payment verification, a cash issue, a stock count, a correction). Having recorded *other* events on the same trip does not stop them from acting.
3. **Closing a trip verifies nothing by itself.** It only checks that every handover, payment and expense on the trip has already been accepted, verified or approved by a second person, and that the cash and stock checks balance. So Accounts may close a trip even if they issued the float, as long as every item they recorded was signed off by someone else.
   - *Example:* Accounts user A issues USD 100 float (the Driver accepts it) and later receives the USD 653 handover. The Driver confirms the handover amount on his side, so the handover is two-sided. Accounts user A verifies the EcoCash and swipe references (recorded by the Driver, not by A). A may then close the trip. A may **not** approve an expense A recorded, or verify a payment A recorded.
   - *If only one Accounts person exists:* any item that needs a second person and was recorded by that Accounts user goes to the Owner. A trip never deadlocks; it waits in a visible "Needs Owner" queue.
4. **The Owner's actions are logged like everyone else's.** Owner overrides require a reason.
5. **Drivers never see costs, margins or other trips.** Cost snapshots are written by the server at ingestion, never supplied by the driver's device. The device shows operational totals only (Section 4).
6. **Every permission is enforced twice:** Postgres RLS policies for reads and writes, and role checks inside the Edge Functions for state changes. The UI hiding a button is never the control.
7. **Permissions are data, not scattered `if` statements.** Define them once in `/packages/schema/permissions.ts`, mirror them in RLS, and test each row of the matrix above in `/supabase/tests`.

---

## SECTION 4C — MOBILE UX STANDARDS (driver app must feel native)

The driver app is built **local-first**: the device already holds the state, and the server catches up.

1. **Instant writes.** Every driver action is written to IndexedDB and shown on screen immediately (optimistic UI). The sync worker uploads in the background. **No spinner ever blocks a driver action** because of the network.
2. **Offline is a normal state, not an error.** A small status pill shows "Offline · 3 queued" / "Synced 14:02". No red error toasts for lost connectivity.
3. **Thumb-zone layout.** Primary navigation is a fixed bottom bar with safe-area padding. The main action on every screen (e.g. "Complete sale") is a full-width button at the bottom.
4. **Touch targets of at least 44×44 px.** Inputs use at least 16px text (prevents zoom on focus). Use numeric keypads (`inputmode="decimal"`) for quantities and money.
5. **No website behaviour.** `overscroll-behavior: contain` (no accidental pull-to-refresh), `touch-action: manipulation`, no hover-only UI, `user-select: none` on buttons and headers.
6. **Bottom sheets instead of centred modals** (vaul / shadcn Drawer).
7. **App shell cached by the service worker.** The app opens in airplane mode. Skeleton screens instead of spinners for office screens that wait on server data.
8. **Performance budget:** initial JS for the driver shell under ~250 KB gzipped. Lists over 50 rows are virtualised. Animate only `transform` and `opacity`. Every UI milestone is tested with Chrome DevTools CPU 4× slowdown and a Slow 3G profile on a mid-range Android phone.
9. **Feedback on every tap:** pressed state (`active:scale-95`), and vibration via `navigator.vibrate` on sale completion where supported.
10. **Manifest:** `display: standalone`, correct icons, theme colour, and a portrait orientation lock for the driver area.
11. **Readable in sunlight:** high-contrast theme, large figures for totals and change due.
12. **Error-proofing money entry:** show the change due in large type before completing a sale, and ask for confirmation for any sale above an Owner-set amount.

---

## SECTION 5 — LOCATION TRACKING

### Behaviour
- Tracking runs **only while the app is open, the user is logged in as Driver, a trip is DISPATCHED, and location consent is active**. Collection stops as soon as the trip leaves DISPATCHED (i.e. at RETURNED) or consent is withdrawn. Test that it actually stops.
- Use `navigator.geolocation.watchPosition` with high accuracy. Record a ping every **30 seconds while moving** (speed > 2 m/s) and every **3 minutes while stationary**. Make these values configurable.
- Pings are written to IndexedDB first, then uploaded in batches when the device is online. Pings recorded offline are uploaded later with their original timestamps.
- Attach the **most recent location fix** to every sale, payment and expense event, with its timestamp and accuracy, so each transaction has a location even if continuous tracking fails.
- **GPS is never a condition of sale.** If the fix is older than 5 minutes, missing, or permission is denied, record `location_status` (`fresh | stale | missing | denied`) on the event and let the sale go ahead immediately. Never make the driver wait for GPS at checkout.
- Describe these coordinates as **"recorded location"**, never as exact proof of presence. Accuracy depends on the phone and the conditions.
- Test foreground tracking on the **actual pilot phone**, not just an emulator. Battery-saver settings differ between Android makers.
- Keep the screen awake during an active trip using the Screen Wake Lock API where it is supported, and tell the driver to keep the app in the foreground.

### Hard limitation (tell the owner; do not hide it)
A browser PWA **cannot reliably track location when the app is in the background or the phone screen is off**. If V1 testing shows gaps that matter, the planned fix is a Capacitor Android build with a foreground-service location plugin. That is a separate milestone (M9) and must not be started without approval.

### `location_pings` table
```
id uuid, trip_id, user_id, device_id, lat, lng, accuracy_m, speed_mps, heading,
battery_pct (if available), source[watch|event|manual], occurred_at, received_at
```

### Maps provider setup (owner tasks, the agent writes the guide)
- **Google Maps Platform:** create a Google Cloud project, enable billing, enable only the **Maps JavaScript API** for V1, create an API key, **restrict it by HTTP referrer** (the production and preview domains) and by API, and set a budget alert. Check current Google pricing before launch. One truck is a small volume, but billing must still be enabled.
- V1 uses the map **for display only, on Owner/Accounts screens only** (last position, today's trail, customer pins). The driver app loads no map tiles. Do not call the Directions, Roads or Distance Matrix APIs in V1. Distance is calculated from the pings in our own code (Haversine), with accuracy filtering.
- All map code goes through `MapProvider` so the provider can be switched to MapLibre without touching the screens.

### Consent and privacy
- On first login the driver sees a plain-language consent screen: what is tracked, when, who can see it, and how long it is kept. Record acceptance as an event.
- Default retention: raw pings kept for 12 months, then summarised. Make this configurable.
- Owner task: confirm employee-tracking obligations under Zimbabwe's Cyber and Data Protection Act, and keep a signed consent form from the driver on file.

---

## SECTION 6 — FINANCIAL RULEBOOK AND ACCEPTANCE SCENARIOS

### Definitions
- **Net sales** = Σ (sale line qty × unit price) − authorised discounts. Credit sales are included; debt collections are not.
- **COGS** = Σ (sale line qty × frozen unit cost snapshot).
- **Gross profit** = Net sales − COGS.
- **An expense has three independent facts**, each recorded separately:
  1. *Reported:* the driver says money was spent (amount, category, receipt photo).
  2. *Paid from:* `driver_cash` (it left the driver's custody), `office` (paid by the office), or `unpaid` (owed to a supplier).
  3. *Approval:* `pending → evidence reviewed → approved | disputed`.
- **Cash** follows *paid from*. **Economics** follow *approval*. A pending repair paid from driver cash reduces expected cash immediately (the money physically left), but counts only in the *provisional* result until it is approved.
- **Trip direct costs** = approved trip expenses + fuel consumption cost (approximate) + allowances. Pending expenses are shown **as a separate line** and included only in the *provisional* result, clearly labelled. Disputed expenses are excluded from both and appear as an open item.
- **Trip contribution** = Gross profit − Trip direct costs. The report shows **Confirmed contribution** (approved costs only) and **Provisional contribution** (including pending) side by side.
- **Expected cash in custody (per currency)** = floats issued + cash sales received − change given + cash debt collections − expenses with `paid_from = driver_cash` (whatever their approval status).
- **Non-cash tenders** (EcoCash, swipe, transfer) are never in driver custody. They are expected *in the company account* and need verification by Accounts.
- **Stock check (at cost)**: Loaded = Sold + Returned + Damaged + Unexplained difference.
- **Costing method:** set by the accountant in `product_costs.method`. Until it is confirmed, use the cost entered on the product as a fixed standard cost and label reports "Cost basis: provisional".
- **Receipts:** V1 receipts must carry the text "Delivery / sales record — not a fiscal tax invoice" unless the accountant confirms otherwise. ZIMRA fiscalisation is an open owner decision.

### Test constants (illustrative, not real market prices or rates)
- FX test rate: **1 USD = 27.00 ZiG** (fixed, source "TEST").
- Products (selling unit = case/bale):

| SKU | Product | Unit cost | Unit price |
|---|---|---|---|
| P1 | Cooking oil 2L × 12 (case) | $30.00 | $36.00 |
| P2 | Sugar 2kg × 10 (bale) | $20.00 | $24.00 |
| P3 | Bath soap (case) | $15.00 | $18.00 |

### Scenario A — normal profitable trip (golden test: every figure must match exactly)

**Departure**
- Warehouse issues and driver accepts: P1 × 20, P2 × 30, P3 × 10. Stock at cost **$1,350.00**; at selling value **$1,620.00**.
- Cash issued to the driver and accepted: **USD 100.00** (float 50.00 + fuel money 50.00) and **ZiG 270.00** float.
- Driver allowance **USD 20.00** is paid by the office. It is a trip expense and is **not** in driver custody.
- Fuel gauge at departure ½, at return ½.

**Sales**
| # | Customer | Lines | Total | Payment |
|---|---|---|---|---|
| S1 | A | P1×5, P2×5 | $300.00 | USD cash 300.00 |
| S2 | B | P1×3, P2×10 | $348.00 | EcoCash USD 200.00 + ZiG cash 2,700.00 (= $100.00) + credit $48.00 |
| S3 | C (created at the sale) | P1×4, P3×5 | $234.00 | USD cash 250.00, change USD 16.00 |
| S4 | D | P2×6, P3×3 | $198.00 | Swipe USD 198.00 |

- **Debt collection:** Customer E pays an old balance of USD cash **75.00** (not a sale).
- **Expenses from driver cash:** fuel USD 50.00 (receipt), toll USD 6.00 (receipt). Both approved.

**Expected results**
| Item | Value |
|---|---|
| Units sold | P1 12, P2 21, P3 8 |
| Net sales | **$1,080.00** |
| COGS | 360 + 420 + 120 = **$900.00** |
| Gross profit | **$180.00** |
| Trip direct costs | fuel 50 + toll 6 + allowance 20 = **$76.00** |
| **Trip contribution** | **$104.00** |
| Stock returned (two-sided, agreed) | P1 8, P2 9, P3 2 = **$450.00** at cost |
| Stock check | 1,350 = 900 sold + 450 returned + 0 damaged + 0 difference ✔ |
| Expected USD cash in custody | 100 + 300 + 250 − 16 + 75 − 50 − 6 = **USD 653.00** |
| Expected ZiG cash in custody | 270 + 2,700 = **ZiG 2,970.00** |
| Expected in company accounts | EcoCash USD 200.00, Swipe USD 198.00 (both to be verified) |
| Receivables | Customer B +$48.00; Customer E −$75.00 |
| Tender check | 300 + 234 + 200 + 100 + 198 + 48 = 1,080 ✔ |
| Driver hands over | USD 653.00, ZiG 2,970.00 → variance **0 / 0** |
| Final state | `CLOSED` (after EcoCash and swipe are verified) |

### Scenario B — provisional loss, fully reconciled
Same departure as A. Only **S1** and **S4** happen. No debt collection. The truck breaks down: repair of **USD 120.00**, `paid_from = driver_cash`, with a receipt, approval **pending**.

| Item | Value |
|---|---|
| Units sold | P1 5, P2 11, P3 3 |
| Net sales | 300 + 198 = **$498.00** |
| COGS | 150 + 220 + 45 = **$415.00** |
| Gross profit | **$83.00** |
| Approved direct costs | **$76.00** |
| Pending expense | **$120.00** (repair, paid from driver cash, approval pending) |
| Confirmed contribution (approved costs only) | **+$7.00** |
| **Provisional contribution (incl. pending)** | **−$113.00** |
| Stock returned | P1 15, P2 19, P3 7 = **$935.00** at cost; 1,350 = 415 + 935 ✔ |
| Expected USD cash in custody | 100 + 300 − 50 − 6 − 120 = **USD 224.00** |
| Expected ZiG cash | **ZiG 270.00** |
| Expected in accounts | Swipe USD 198.00 |
| Driver hands over | USD 224.00, ZiG 270.00 → variance **0 / 0** |
| Report verdict | Economics: **provisional loss** (confirmed +$7.00, provisional −$113.00). Accountability: **all resources accounted for**. Action: Owner to review the repair expense. |
| Final state | `CLOSED_WITH_EXCEPTIONS` until the repair is approved or disputed (an expense still pending is an open item) |

### Scenario B2 — confirmed loss, fully reconciled
Same as B, then the Owner **approves** the repair.

| Item | Value |
|---|---|
| Approved direct costs | 76 + 120 = **$196.00** |
| Pending expenses | **$0.00** |
| **Confirmed contribution** | 83 − 196 = **−$113.00** |
| Provisional contribution | **−$113.00** (same; nothing pending) |
| Expected cash / handover | Unchanged from B: USD 224.00, ZiG 270.00, variance **0 / 0** |
| Final state | `CLOSED` |
| Report verdict | Economics: **loss (confirmed)**. Accountability: **all resources accounted for**. This is the case the report must show as *poor trip economics, not poor accountability*. |

### Scenario C — profitable trip with open discrepancies
Same as A, except:
- The driver hands over **USD 633.00** (expected 653.00) and ZiG 2,970.00.
- The return count shows **P3 × 1** (expected 2). Warehouse and driver both count 1.

| Item | Value |
|---|---|
| Trip contribution | **$104.00** (unchanged; the discrepancies are *not* recognised as costs until confirmed) |
| Cash | **Reconciliation difference: USD 20.00**, ZiG 0 |
| Stock | **Reconciliation difference: P3 × 1 = $15.00 at cost** ($18.00 at selling value) |
| Stock check | 1,350 = 900 sold + 435 returned + 0 damaged + 15 difference ✔ |
| Final state | Cannot be `CLOSED`. Only `CLOSED_WITH_EXCEPTIONS`, with both items assigned to Accounts and given a due date |
| Report verdict | Economics: **profitable**. Accountability: **2 open differences ($35.00 exposure at cost/cash)**. Data confidence: **verified except open items**. |

### Scenario D — offline replay test
1. The device goes offline after dispatch. Record S1–S4, the collection, both expenses and 40 location pings while offline.
2. Force-close the app. Reopen it. All events are still there.
3. Reconnect and let sync run, then simulate the same batch being sent **5 times**.
4. Expected: exactly 4 sales, 1 collection, 2 expenses and 40 pings on the server. Results identical to Scenario A.
5. Create the same customer twice offline (same phone number). Expected on sync: both records exist, flagged as a **possible duplicate**; a merge is available to Accounts and not to the driver.

**Sale-level integrity (part of Scenario D).** A sale is a bundle: sale + lines + stock movements + payments. Rules:
- On the device, the whole bundle is saved in **one IndexedDB transaction**. "Sale saved" is shown only after that transaction commits.
- On the server, the bundle is committed in **one database transaction** (a Postgres function called by the ingest Edge Function). Either all of it is posted or none of it is. The sale ID is the idempotency key.
- Required tests:
  - **D1 — restart after local save:** kill the app straight after "Sale saved". Reopen: the sale is there, still queued, and syncs once.
  - **D2 — lost acknowledgement:** the server commits, but the phone never receives the reply. The phone retries. Expected: one sale on the server; the phone marks it synced.
  - **D3 — conflicting resubmission:** the same sale ID arrives with different contents (e.g. a changed quantity). Expected: the server rejects the second version, keeps the first, and raises a visible **"Conflicting resubmission"** exception for Accounts. It is never silently overwritten or merged.
  - **D4 — partial failure:** force an error halfway through the server commit (e.g. invalid payment line). Expected: nothing from that sale is posted, and the phone shows the sale as "Needs attention", not "Synced".
- The result is always **one complete sale or one visible exception**, never a half-posted sale that looks successful.

### Scenario E — revoked device
The Owner revokes the driver's phone while it is offline with 3 unsynced sales. The phone reconnects. Expected: the token is rejected, the app returns to sign-in, the 3 sales are uploaded to a **quarantine** area (not the ledger), and Accounts sees them for review.

### Where each scenario is tested (gates per milestone)
| Milestone | What must pass |
|---|---|
| M1 | Scenarios **A, B, B2, C** as pure engine unit tests (fixtures in, results out) |
| M2 | Every permission-matrix row; separation-of-duties rules; A–C events posted through the ingest API produce the same results as M1; D3 and D4 at the API level |
| M3 | Scenario **D** (incl. D1–D4) and **E** through a test harness that drives the sync client directly (no UI needed) |
| M6 | Scenario A performed by hand through the real driver screens matches M1 exactly |
| M7 | Scenarios A, B, B2 and C, from departure to close, through the real screens, with the correct report and end state |
| M8 | Location: online/offline pings, stale/missing/denied fixes never block a sale, collection stops at RETURNED |

A milestone is complete only when its own gate passes **and** every earlier gate still passes.

---

## SECTION 7 — MILESTONES (build in this order)

| # | Milestone | Definition of done |
|---|---|---|
| M0 | Repo, tooling, CI, Supabase project, Vercel preview, PWA shell | App installs on an Android phone and opens offline with a placeholder screen. CI runs lint, typecheck and tests |
| M1 | Financial engine (pure TS) | Scenarios A, B and C pass as unit tests. No UI yet |
| M2 | Database schema, auth, roles, device registration, RLS, event ingestion endpoint (idempotent) | Events are posted and replayed; projections rebuild from events; every row of the permission matrix (Section 4B) has a passing test; separation-of-duties rules are enforced server-side |
| M3 | Offline outbox and sync | Scenarios D (D1–D4) and E pass through the sync test harness |
| M4 | Back office: products, prices, costs, FX rates, customers, truck, users | Owner/Accounts can set up everything needed for a trip |
| M5 | Trip setup, warehouse loading, driver departure screen, dispatch approval | Two-sided stock and cash acceptance works, including dispute; a safety defect blocks dispatch |
| M6 | Driver POS: sales, mixed tender, change, credit, new customers, receipts, collections, expenses | Scenario A can be performed by hand in the UI and produces identical numbers |
| M7 | Return, cash handover, verification, trip-close report | Scenarios A, B, B2 and C produce the correct reports and end states in the UI. **The close report is proven before any map work starts** |
| M8 | Location tracking and owner live map | Pings recorded online and offline; map shows last position with freshness; consent flow works; GPS never blocks a sale |
| M9 | *(Approval needed)* Capacitor Android build with background location | Only if M8 field testing shows unacceptable gaps |
| M10 | Field pilot hardening | Real trips run; the bug list is triaged; owner signs off on V1.0 |

**Test defaults vs live settings.** The Section 6 costs, prices, FX rate and receipt wording are **test fixtures only**. They are seeded in local and staging and must never be seeded into production. They are not evidence that the live setup meets GC's legal or accounting obligations.

**Go-live gate (before the first real sale in production):**
- [ ] The accountant has confirmed the costing method, the FX treatment and the receipt/fiscalisation workflow (recorded in DECISIONS.md)
- [ ] Real products, costs, prices and credit limits have been entered and checked by the Owner
- [ ] The driver has signed the tracking consent form
- [ ] Scenarios D and E have been run on the actual pilot phone
- [ ] A backup restore test has succeeded
- [ ] The Owner has signed off in DECISIONS.md

**V1.0 is complete when:** ten consecutive real trips have been run and closed in GC, every variance has been explained or assigned to someone, and the owner confirms the trip-close report is trusted.

---

## SECTION 8 — STATE.md TEMPLATE (the agent maintains this)

```markdown
# GC V1.0 — STATE
Last updated: <date/time> by <agent session>
Current milestone: M<n> — <name>
Status: IN PROGRESS | BLOCKED | AWAITING OWNER REVIEW

## Done this session
- ...

## Tests
- Scenarios: A ✔/✘  B ✔/✘  B2 ✔/✘  C ✔/✘  D1–D4 ✔/✘  E ✔/✘
- Typecheck / lint / unit / e2e: ...

## Next 3 tasks
1. ...

## Blockers / owner decisions needed
- ...

## Known risks / tech debt
- ...
```

`DECISIONS.md` records each decision as: `ID · date · decision · reason · status (OPEN / APPROVED / REJECTED) · who decided`.

---

## SECTION 9 — LOOP PROMPT (paste at the start of every session after the first)

```
Continue building Game Command V1.0.

1. READ: GC_MASTER_PROMPT.md, STATE.md and DECISIONS.md. Summarise in 5 lines where we are.
2. CHECK: Run the full test suite. If anything that passed before now fails, fix it before doing anything new.
3. PLAN: Take the next unfinished tasks for the current milestone. Write a short plan (max 10 bullets) listing the files you will touch and the tests you will add.
4. BUILD: Implement in small commits. Write tests first for anything touching money, stock, sync or permissions.
5. VERIFY: Run typecheck, lint, unit and e2e tests. For UI work, describe how you checked it at a 360px-wide mobile viewport and with the network offline.
6. RECORD: Update STATE.md. Add any new questions to DECISIONS.md as OPEN.
7. REPORT to the owner, in plain language:
   - What now works (that the owner could try)
   - Test results
   - Decisions needed from the owner
   - The next step
8. STOP at the end of each milestone and wait for owner approval before starting the next one.

Rules you must never break:
- Never violate Section 2. If a task seems to require it, stop and ask.
- Never edit or delete rows in trip_events. Corrections are new events.
- Never use floating-point numbers for money.
- Never add features from the "Out of scope" list.
- Never commit secrets. API keys go in environment variables; the Maps key is restricted by referrer.
- Never rely on the UI to enforce a permission. Every permission is enforced in RLS and Edge Functions and covered by a test.
- Never send product costs or margins to a Driver's device.
- Never make a driver action wait on the network (Section 4C).
- If you are unsure about a business rule, ask. Do not guess and build on the guess.
```

---

## SECTION 10 — OPEN OWNER DECISIONS (resolve before the milestone shown)

| Decision | Needed by |
|---|---|
| Inventory costing method (accountant). Suggested default: weighted average cost, unless the accountant requires FIFO | M1 is finalised (standard cost is used until then) |
| Whether receipts must be ZIMRA-fiscalised, or V1 issues internal delivery/cash-sale dockets with fiscal invoices raised at the depot | M6 |
| FX rule: **(a)** one Trip Rate locked at dispatch and used for all USD-equivalent figures on that trip (simplest to reconcile), or **(b)** the daily official rate per transaction. Either way, ZiG cash is always reconciled in ZiG | M4 |
| Official FX rate source and who enters it | M4 |
| Accounts' expense approval limit; discount limit (if any); sale confirmation threshold | M6 |
| Credit policy: who may buy on credit, default limits | M6 |
| Expense categories and approval limits | M6 |
| Discounts: allowed? Up to what % and by whom? | M6 |
| Maps provider and billing account owner | M8 |
| Driver tracking consent form and retention period | M8 |
| Selling units: whole cases only, or also single units? | M4 |
