-- GC V1.0 · M2 · 0001 core schema
-- Section 4 "Core data model". Money is always bigint minor units + currency (Section 2 #4); FX rates are
-- decimal strings with source and timestamp. Every table carries org_id so more trucks/orgs fit later.
-- Never edit this file once applied: add a new migration instead.

create schema if not exists gc;            -- private helpers (not exposed by the API)
grant usage on schema gc to authenticated, service_role;

create type gc.role as enum ('owner', 'accounts', 'warehouse', 'driver');
create type gc.currency as enum ('USD', 'ZWG');  -- ZiG is ISO ZWG (D-047)
create type gc.trip_state as enum (
  'DRAFT', 'LOADING', 'AWAITING_ACCEPTANCE', 'DISPATCHED', 'RETURNED', 'RECONCILING',
  'CLOSED', 'CLOSED_WITH_EXCEPTIONS');
create type gc.device_kind as enum ('driver_phone', 'office');

-- ---------------------------------------------------------------------------------------------------------
-- Organisation, people, roles, devices
-- ---------------------------------------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.org_settings (
  org_id uuid primary key references public.organizations(id),
  -- D-024 (approved): device clock vs server clock at upload; events in a skewed batch are flagged.
  clock_skew_minutes int not null default 10 check (clock_skew_minutes > 0),
  -- Section 4B "Discount / price override": off by default (null). Owner sets the % limit.
  driver_discount_max_pct numeric(5,2) check (driver_discount_max_pct between 0 and 100),
  -- Section 4C #12: confirmation for sales above an Owner-set amount (USD minor units). Null = not set.
  sale_confirm_threshold_minor bigint check (sale_confirm_threshold_minor >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- Section 4B "Approve / dispute expense": Accounts up to an Owner-set limit, per currency.
-- No row for a currency = Accounts cannot approve it; it goes to the Owner ("Needs Owner").
create table public.expense_approval_limits (
  org_id uuid not null references public.organizations(id),
  currency gc.currency not null,
  max_minor bigint not null check (max_minor >= 0),
  set_by uuid not null,
  set_at timestamptz not null default now(),
  primary key (org_id, currency)
);

create table public.profiles (
  user_id uuid primary key references auth.users(id),
  org_id uuid not null references public.organizations(id),
  display_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid not null references public.profiles(user_id),
  role gc.role not null,
  granted_by uuid,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

-- Section 4 "Device registration". The id is generated on the phone.
create table public.devices (
  id uuid primary key,
  org_id uuid not null references public.organizations(id),
  user_id uuid not null references public.profiles(user_id),
  kind gc.device_kind not null,
  label text,
  registered_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  last_sync_at timestamptz
);

-- ---------------------------------------------------------------------------------------------------------
-- Catalogue, prices, costs, FX
-- ---------------------------------------------------------------------------------------------------------
create table public.trucks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  registration text not null,
  active boolean not null default true,
  unique (org_id, registration)
);

create table public.routes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  name text not null
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  sku text not null,
  name text not null,
  base_unit text not null,
  pack_size int not null check (pack_size > 0),
  active boolean not null default true,
  unique (org_id, sku)
);

-- Cost history is append-only: a new row with a later effective_from supersedes the old one, so
-- historical snapshots are never rewritten (Section 2 #7). `method` is set by the accountant (Section 6).
create table public.product_costs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  product_id uuid not null references public.products(id),
  unit_cost_minor bigint not null check (unit_cost_minor >= 0),
  currency gc.currency not null,
  effective_from timestamptz not null,
  method text not null default 'standard',
  basis text not null default 'provisional' check (basis in ('provisional', 'confirmed')),
  entered_by uuid not null,
  entered_at timestamptz not null default now(),
  unique (product_id, effective_from)
);

create table public.price_lists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  name text not null,
  currency gc.currency not null default 'USD',  -- prices in one currency per list (D-020 open)
  active boolean not null default true
);

create table public.price_list_items (
  price_list_id uuid not null references public.price_lists(id),
  product_id uuid not null references public.products(id),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  primary key (price_list_id, product_id)
);

-- Append-only: a new rate is a new row (Section 2 #4: decimal string + source + timestamp).
create table public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  from_ccy gc.currency not null,
  to_ccy gc.currency not null,
  rate_decimal text not null check (rate_decimal ~ '^\d+(\.\d+)?$' and rate_decimal !~ '^0+(\.0+)?$'),
  source text not null check (length(source) > 0),
  effective_at timestamptz not null,
  entered_by uuid not null,
  entered_at timestamptz not null default now(),
  check (from_ccy <> to_ccy)
);

-- ---------------------------------------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------------------------------------
create table public.customers (
  id uuid primary key,  -- client-generated when created during a sale
  org_id uuid not null references public.organizations(id),
  name text not null,
  phone text,
  phone_digits text generated always as (nullif(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), '')) stored,
  lat double precision,  -- coordinates, not money
  lng double precision,
  business_type text,
  credit_limit_minor bigint check (credit_limit_minor >= 0),  -- Owner only (Section 4B)
  credit_currency gc.currency not null default 'USD',
  created_on_trip_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  merged_into_id uuid references public.customers(id),
  possible_duplicate_of uuid references public.customers(id)  -- Scenario D5: flagged at sync, never merged automatically
);
create index customers_phone_digits on public.customers (org_id, phone_digits);

-- ---------------------------------------------------------------------------------------------------------
-- Trips and the event ledger
-- ---------------------------------------------------------------------------------------------------------
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  truck_id uuid not null references public.trucks(id),
  driver_id uuid not null references public.profiles(user_id),
  route_id uuid references public.routes(id),
  price_list_id uuid not null references public.price_lists(id),
  state gc.trip_state not null default 'DRAFT',
  planned_date date not null,
  business_date date,          -- set at dispatch, never changes (Section 4)
  created_by uuid not null,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  returned_at timestamptz,
  closed_at timestamptz
);
-- D-007 (approved): one active trip per truck. DRAFT is planning and does not count.
create unique index trips_one_active_per_truck on public.trips (truck_id)
  where state in ('LOADING', 'AWAITING_ACCEPTANCE', 'DISPATCHED', 'RETURNED', 'RECONCILING');

-- Section 2 #2: append-only. `payload` is the event exactly as the client sent it (no costs for sales).
create table public.trip_events (
  seq bigint generated always as identity unique,  -- order of receipt (used to rebuild projections)
  id uuid primary key,
  org_id uuid not null references public.organizations(id),
  trip_id uuid not null references public.trips(id),
  type text not null,
  payload jsonb not null,
  actor_id uuid not null,
  device_id uuid references public.devices(id),
  occurred_at timestamptz not null,               -- device clock
  received_at timestamptz not null default now(), -- server clock
  batch_id uuid,
  reverses_event_id uuid references public.trip_events(id),
  reason text,
  status text not null default 'posted',
  clock_skew boolean not null default false       -- D-024: batch device clock differed by > N minutes
);
create index trip_events_trip on public.trip_events (trip_id, seq);

-- Section 2 #7 / Section 4: the unit cost snapshot for each sale line, written by the server at ingestion.
-- Kept apart from trip_events (which drivers may read) so a driver can never read a cost (Section 4B rule 5).
create table public.sale_line_costs (
  event_id uuid not null references public.trip_events(id),
  line_id uuid not null,
  product_id uuid not null references public.products(id),
  unit_cost_minor bigint not null check (unit_cost_minor >= 0),
  currency gc.currency not null,
  product_cost_id uuid not null references public.product_costs(id),
  cost_as_of timestamptz not null,
  as_of_basis text not null check (as_of_basis in ('occurred_at', 'received_at')),
  primary key (event_id, line_id)
);

-- Scenario E / D-032: everything a revoked device uploads lands here, never in the ledger.
create table public.quarantined_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id),
  device_id uuid not null references public.devices(id),
  user_id uuid not null,
  event_id text,
  raw jsonb not null,
  received_at timestamptz not null default now(),
  reason text not null,
  reviewed_by uuid,
  reviewed_at timestamptz,
  resolution text
);

-- Visible exceptions for Accounts: conflicting resubmissions (D3), rejected events (D4), clock-skew reviews,
-- credit over limit, price mismatches, missing costs. Rows are added, and resolved by a later update.
create table public.ingest_exceptions (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id),
  kind text not null check (kind in ('conflicting_resubmission', 'rejected', 'clock_skew_review',
    'credit_over_limit', 'price_mismatch', 'missing_cost', 'possible_duplicate_customer')),
  event_id text,
  trip_id uuid,
  user_id uuid,
  device_id uuid,
  detail text not null,
  raw jsonb,
  created_at timestamptz not null default now(),
  resolved_by uuid,
  resolved_at timestamptz,
  resolution text
);

-- ---------------------------------------------------------------------------------------------------------
-- Projections (derived from trip_events; rebuildable at any time with gc.rebuild_projections)
-- ---------------------------------------------------------------------------------------------------------
create table public.sales (
  id uuid primary key,  -- = sale id = event id (idempotency key)
  event_id uuid not null references public.trip_events(id),
  trip_id uuid not null references public.trips(id),
  customer_id uuid not null,
  total_minor bigint not null,
  currency gc.currency not null,
  occurred_at timestamptz not null,
  reversed_by uuid
);

create table public.sale_lines (
  sale_id uuid not null references public.sales(id),
  line_id uuid not null,
  product_id uuid not null,
  qty_base_units int not null check (qty_base_units > 0),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  currency gc.currency not null,
  primary key (sale_id, line_id)
);

create table public.payments (
  id uuid primary key,
  trip_id uuid not null references public.trips(id),
  event_id uuid not null references public.trip_events(id),
  sale_id uuid references public.sales(id),
  collection_id uuid,
  customer_id uuid not null,
  recorded_by uuid not null,
  tender text not null check (tender in ('cash', 'ecocash', 'swipe', 'transfer', 'credit')),
  currency gc.currency not null,
  amount_minor bigint not null check (amount_minor >= 0),
  change_minor bigint not null default 0 check (change_minor >= 0),
  fx_rate_decimal text,
  fx_rate_id uuid,
  reference text,
  verification_status text not null default 'not_required'
    check (verification_status in ('not_required', 'pending', 'verified', 'rejected')),
  reversed_by uuid,
  check ((sale_id is null) <> (collection_id is null))
);

create table public.handovers (
  id uuid primary key,
  trip_id uuid not null references public.trips(id),
  kind text not null check (kind in ('stock', 'cash', 'fuel')),
  direction text not null check (direction in ('to_truck', 'from_truck')),
  issuer_id uuid not null,
  issuer_lines jsonb not null,
  issued_event_id uuid not null references public.trip_events(id),
  receiver_id uuid,
  receiver_lines jsonb,
  responded_event_id uuid references public.trip_events(id),
  response text check (response in ('accept', 'accept_discrepancy', 'dispute')),
  status text not null default 'awaiting_response'
    check (status in ('awaiting_response', 'accepted', 'accepted_with_discrepancy', 'disputed', 'reversed'))
);

create table public.expenses (
  id uuid primary key,
  trip_id uuid not null references public.trips(id),
  event_id uuid not null references public.trip_events(id),
  reported_by uuid not null,
  category text not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency gc.currency not null,
  paid_from text not null check (paid_from in ('driver_cash', 'office', 'unpaid')),
  receipt_photo_path text,
  approval_status text not null default 'pending'
    check (approval_status in ('pending', 'evidence_reviewed', 'approved', 'disputed')),
  reviewed_by uuid,
  reversed_by uuid
);

-- Open items assigned an owner and due date when a trip is closed with exceptions (Section 4 state machine).
create table public.trip_close_exceptions (
  trip_id uuid not null references public.trips(id),
  item_ref text not null,
  kind text not null,
  detail text,
  assigned_to uuid not null references public.profiles(user_id),
  due_date date not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (trip_id, item_ref)
);

-- Section 5. Ingestion of pings is M3/M8; the table and its RLS exist from M2.
create table public.location_pings (
  id uuid primary key,
  org_id uuid not null references public.organizations(id),
  trip_id uuid not null references public.trips(id),
  user_id uuid not null,
  device_id uuid not null references public.devices(id),
  lat double precision not null,
  lng double precision not null,
  accuracy_m double precision,
  speed_mps double precision,
  heading double precision,
  battery_pct smallint,
  source text not null check (source in ('watch', 'event', 'manual')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------------------
-- Append-only guards. These fire for every role, including service_role and table owners.
-- ---------------------------------------------------------------------------------------------------------
create function gc.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only: % is not allowed (Section 2 #2). Record a correcting event instead.',
    tg_table_name, tg_op using errcode = 'P0001';
end $$;

create trigger trip_events_append_only before update or delete on public.trip_events
  for each row execute function gc.forbid_change();
create trigger trip_events_no_truncate before truncate on public.trip_events
  for each statement execute function gc.forbid_change();
create trigger sale_line_costs_append_only before update or delete on public.sale_line_costs
  for each row execute function gc.forbid_change();
create trigger sale_line_costs_no_truncate before truncate on public.sale_line_costs
  for each statement execute function gc.forbid_change();
create trigger product_costs_append_only before update or delete on public.product_costs
  for each row execute function gc.forbid_change();
create trigger exchange_rates_append_only before update or delete on public.exchange_rates
  for each row execute function gc.forbid_change();
create trigger quarantined_events_no_delete before delete on public.quarantined_events
  for each row execute function gc.forbid_change();
create trigger ingest_exceptions_no_delete before delete on public.ingest_exceptions
  for each row execute function gc.forbid_change();
