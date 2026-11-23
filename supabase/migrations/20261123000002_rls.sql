-- GC V1.0 · M2 · 0002 role helpers and Row Level Security on EVERY table (Section 4 architecture rules).
-- Mirrors packages/schema/src/permissions.ts. Writes to the ledger and projections happen only through
-- SECURITY DEFINER functions (0003, 0004); no client role has a write policy on them.

-- ---------------------------------------------------------------------------------------------------------
-- Request context
-- ---------------------------------------------------------------------------------------------------------

-- Device id sent by the app as the `x-gc-device-id` header (PostgREST exposes headers as a setting).
create function gc.header_device_id() returns uuid
language plpgsql stable as $$
declare v text;
begin
  v := nullif(current_setting('request.headers', true), '')::json ->> 'x-gc-device-id';
  return v::uuid;
exception when others then
  return null;
end $$;

-- D-027 (approved): a request from the user's own registered driver phone gets driver powers only.
create function gc.on_driver_device(p_uid uuid, p_device uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.devices d
                 where d.id = p_device and d.user_id = p_uid and d.kind = 'driver_phone')
$$;

-- Section 4 "Two-factor authentication is required for Owner": Owner powers need an aal2 session.
create function gc.session_aal2() returns boolean
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'aal', '') = 'aal2'
$$;

-- Effective roles of a user for one request.
create function gc.roles_for(p_uid uuid, p_device uuid, p_aal2 boolean) returns gc.role[]
language sql stable security definer set search_path = '' as $$
  with held as (
    select r.role from public.user_roles r
    join public.profiles p on p.user_id = r.user_id and p.active
    where r.user_id = p_uid
  ), driver_phone as (select gc.on_driver_device(p_uid, p_device) as yes)
  select coalesce(array_agg(h.role order by h.role), '{}')
  from held h, driver_phone dp
  where (not dp.yes or h.role = 'driver')
    and (h.role <> 'owner' or p_aal2)
$$;

create function gc.my_roles() returns gc.role[]
language sql stable as $$ select gc.roles_for(auth.uid(), gc.header_device_id(), gc.session_aal2()) $$;

create function gc.has_role(p_role gc.role) returns boolean
language sql stable as $$ select p_role = any (gc.my_roles()) $$;

create function gc.is_office() returns boolean  -- Owner or Accounts
language sql stable as $$ select gc.my_roles() && array['owner', 'accounts']::gc.role[] $$;

create function gc.my_org() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.org_id from public.profiles p where p.user_id = auth.uid() and p.active
$$;

-- "No other trips are ever on the device": a driver sees only trips assigned to them that are in progress.
create function gc.driver_trip_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select t.id from public.trips t
  where t.driver_id = auth.uid()
    and gc.has_role('driver')
    and t.state in ('LOADING', 'AWAITING_ACCEPTANCE', 'DISPATCHED', 'RETURNED', 'RECONCILING')
$$;

-- Warehouse works on trips being loaded or returned.
create function gc.warehouse_trip_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select t.id from public.trips t
  where t.org_id = gc.my_org() and gc.has_role('warehouse')
    and t.state in ('LOADING', 'AWAITING_ACCEPTANCE', 'RETURNED', 'RECONCILING')
$$;

grant execute on all functions in schema gc to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- Grants: anon gets nothing. RLS decides what authenticated users see and change.
-- ---------------------------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- Enable RLS on every table in public (a test checks no table is missed).
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    -- Not FORCE: the table owner is used only inside SECURITY DEFINER functions, which do their own checks.
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------------------------------------

-- organizations / settings
create policy org_read on public.organizations for select to authenticated using (id = gc.my_org());
create policy settings_read on public.org_settings for select to authenticated using (org_id = gc.my_org());
-- Discount limit, sale threshold, clock tolerance: Owner sets policy (Section 4B "Discount / price override").
create policy settings_owner_write on public.org_settings for update to authenticated
  using (org_id = gc.my_org() and gc.has_role('owner')) with check (org_id = gc.my_org() and gc.has_role('owner'));
create policy expense_limits_read on public.expense_approval_limits for select to authenticated
  using (org_id = gc.my_org() and gc.is_office());
create policy expense_limits_owner_insert on public.expense_approval_limits for insert to authenticated
  with check (org_id = gc.my_org() and gc.has_role('owner') and set_by = auth.uid());
create policy expense_limits_owner_update on public.expense_approval_limits for update to authenticated
  using (org_id = gc.my_org() and gc.has_role('owner')) with check (org_id = gc.my_org() and gc.has_role('owner'));
create policy expense_limits_owner_delete on public.expense_approval_limits for delete to authenticated
  using (org_id = gc.my_org() and gc.has_role('owner'));

-- profiles / roles / devices — "Create users, assign roles, revoke devices": Owner only.
create policy profiles_read on public.profiles for select to authenticated
  using (user_id = auth.uid() or (org_id = gc.my_org() and gc.is_office()));
create policy profiles_owner_insert on public.profiles for insert to authenticated
  with check (org_id = gc.my_org() and gc.has_role('owner'));
create policy profiles_owner_update on public.profiles for update to authenticated
  using (org_id = gc.my_org() and gc.has_role('owner')) with check (org_id = gc.my_org() and gc.has_role('owner'));

create policy roles_read on public.user_roles for select to authenticated
  using (user_id = auth.uid() or (gc.is_office()
         and exists (select 1 from public.profiles p where p.user_id = user_roles.user_id and p.org_id = gc.my_org())));
create policy roles_owner_insert on public.user_roles for insert to authenticated
  with check (gc.has_role('owner') and granted_by = auth.uid()
              and exists (select 1 from public.profiles p where p.user_id = user_roles.user_id and p.org_id = gc.my_org()));
create policy roles_owner_delete on public.user_roles for delete to authenticated
  using (gc.has_role('owner')
         and exists (select 1 from public.profiles p where p.user_id = user_roles.user_id and p.org_id = gc.my_org()));

create policy devices_read on public.devices for select to authenticated
  using (user_id = auth.uid() or (org_id = gc.my_org() and gc.is_office()));
-- Registration and revocation go through register_device / revoke_device (0004). No direct writes.

-- catalogue — "Products and pack sizes": Owner, Accounts write; Warehouse view; Driver view (own trip).
create policy trucks_read on public.trucks for select to authenticated using (org_id = gc.my_org());
create policy trucks_write on public.trucks for all to authenticated
  using (org_id = gc.my_org() and gc.is_office()) with check (org_id = gc.my_org() and gc.is_office());
create policy routes_read on public.routes for select to authenticated using (org_id = gc.my_org());
create policy routes_write on public.routes for all to authenticated
  using (org_id = gc.my_org() and gc.is_office()) with check (org_id = gc.my_org() and gc.is_office());

create policy products_office_read on public.products for select to authenticated
  using (org_id = gc.my_org() and (gc.is_office() or gc.has_role('warehouse')));
create policy products_driver_read on public.products for select to authenticated
  using (exists (select 1 from public.trips t join public.price_list_items i on i.price_list_id = t.price_list_id
                 where t.id in (select gc.driver_trip_ids()) and i.product_id = products.id));
create policy products_insert on public.products for insert to authenticated
  with check (org_id = gc.my_org() and gc.is_office());
create policy products_update on public.products for update to authenticated
  using (org_id = gc.my_org() and gc.is_office()) with check (org_id = gc.my_org() and gc.is_office());

-- "Set product costs": Owner, Accounts. Driver NEVER sees cost (rule 5). Warehouse: no. Append-only.
create policy costs_read on public.product_costs for select to authenticated
  using (org_id = gc.my_org() and gc.is_office());
create policy costs_insert on public.product_costs for insert to authenticated
  with check (org_id = gc.my_org() and gc.is_office() and entered_by = auth.uid());

-- "Set selling prices / price list": Owner only. Accounts may read. Driver: cached copy of own trip's list.
create policy price_lists_read on public.price_lists for select to authenticated
  using ((org_id = gc.my_org() and gc.is_office())
         or id in (select t.price_list_id from public.trips t where t.id in (select gc.driver_trip_ids())));
create policy price_lists_write on public.price_lists for all to authenticated
  using (org_id = gc.my_org() and gc.has_role('owner')) with check (org_id = gc.my_org() and gc.has_role('owner'));
create policy price_items_read on public.price_list_items for select to authenticated
  using (exists (select 1 from public.price_lists l where l.id = price_list_items.price_list_id
                 and l.org_id = gc.my_org() and gc.is_office())
         or price_list_id in (select t.price_list_id from public.trips t where t.id in (select gc.driver_trip_ids())));
create policy price_items_write on public.price_list_items for all to authenticated
  using (gc.has_role('owner') and exists (select 1 from public.price_lists l
         where l.id = price_list_items.price_list_id and l.org_id = gc.my_org()))
  with check (gc.has_role('owner') and exists (select 1 from public.price_lists l
         where l.id = price_list_items.price_list_id and l.org_id = gc.my_org()));

-- "Enter daily FX rate": Owner, Accounts. Driver view. Append-only.
create policy fx_read on public.exchange_rates for select to authenticated
  using (org_id = gc.my_org() and (gc.is_office() or gc.has_role('driver')));
create policy fx_insert on public.exchange_rates for insert to authenticated
  with check (org_id = gc.my_org() and gc.is_office() and entered_by = auth.uid());

-- customers — create: Owner, Accounts (driver via CUSTOMER_CREATED during a sale); edit/merge: Owner, Accounts;
-- credit limits: Owner only (trigger below). Driver reads the org's active customers to sell to them (D-051).
create policy customers_office_read on public.customers for select to authenticated
  using (org_id = gc.my_org() and gc.is_office());
create policy customers_driver_read on public.customers for select to authenticated
  using (org_id = gc.my_org() and gc.has_role('driver') and merged_into_id is null
         and exists (select 1 from gc.driver_trip_ids()));
create policy customers_insert on public.customers for insert to authenticated
  with check (org_id = gc.my_org() and gc.is_office());
create policy customers_update on public.customers for update to authenticated
  using (org_id = gc.my_org() and gc.is_office()) with check (org_id = gc.my_org() and gc.is_office());

create function gc.guard_credit_limit() returns trigger
language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon')
     and (tg_op = 'INSERT' and new.credit_limit_minor is not null
          or tg_op = 'UPDATE' and new.credit_limit_minor is distinct from old.credit_limit_minor)
     and not gc.has_role('owner') then
    raise exception 'only the Owner sets customer credit limits (Section 4B)' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger customers_credit_limit_owner before insert or update on public.customers
  for each row execute function gc.guard_credit_limit();

-- trips — "Create / plan trip": Owner, Accounts. State changes only via set_trip_state / close (0004).
create policy trips_office_read on public.trips for select to authenticated
  using (org_id = gc.my_org() and gc.is_office());
create policy trips_warehouse_read on public.trips for select to authenticated
  using (id in (select gc.warehouse_trip_ids()));
create policy trips_driver_read on public.trips for select to authenticated
  using (id in (select gc.driver_trip_ids()));
create policy trips_insert on public.trips for insert to authenticated
  with check (org_id = gc.my_org() and gc.is_office() and state = 'DRAFT' and created_by = auth.uid()
              and business_date is null);

-- trip_events — "View audit log": Owner, Accounts. Driver: own trip's events (no costs inside).
-- Warehouse: stock events of trips it works on. Nobody writes directly.
create policy events_office_read on public.trip_events for select to authenticated
  using (org_id = gc.my_org() and gc.is_office());
create policy events_driver_read on public.trip_events for select to authenticated
  using (trip_id in (select gc.driver_trip_ids()));
create policy events_warehouse_read on public.trip_events for select to authenticated
  using (trip_id in (select gc.warehouse_trip_ids())
         and type in ('STOCK_HANDOVER_ISSUED', 'STOCK_HANDOVER_RESPONDED', 'STOCK_DAMAGED'));

-- Cost snapshots: Owner, Accounts only (economics are server/office only).
create policy line_costs_read on public.sale_line_costs for select to authenticated
  using (gc.is_office() and exists (select 1 from public.trip_events e
         where e.id = sale_line_costs.event_id and e.org_id = gc.my_org()));

-- Review queues: Owner, Accounts.
create policy quarantine_read on public.quarantined_events for select to authenticated
  using (org_id = gc.my_org() and gc.is_office());
create policy exceptions_read on public.ingest_exceptions for select to authenticated
  using (org_id = gc.my_org() and gc.is_office());

-- Projections: office reads; driver reads own trip; warehouse reads stock handovers of its trips.
create policy sales_read on public.sales for select to authenticated
  using ((gc.is_office() and exists (select 1 from public.trips t where t.id = sales.trip_id and t.org_id = gc.my_org()))
         or trip_id in (select gc.driver_trip_ids()));
create policy sale_lines_read on public.sale_lines for select to authenticated
  using (exists (select 1 from public.sales s where s.id = sale_lines.sale_id));  -- inherits sales RLS
create policy payments_read on public.payments for select to authenticated
  using ((gc.is_office() and exists (select 1 from public.trips t where t.id = payments.trip_id and t.org_id = gc.my_org()))
         or trip_id in (select gc.driver_trip_ids()));
create policy handovers_read on public.handovers for select to authenticated
  using ((gc.is_office() and exists (select 1 from public.trips t where t.id = handovers.trip_id and t.org_id = gc.my_org()))
         or trip_id in (select gc.driver_trip_ids())
         or (kind = 'stock' and trip_id in (select gc.warehouse_trip_ids())));
create policy expenses_read on public.expenses for select to authenticated
  using ((gc.is_office() and exists (select 1 from public.trips t where t.id = expenses.trip_id and t.org_id = gc.my_org()))
         or trip_id in (select gc.driver_trip_ids()));
create policy close_exceptions_read on public.trip_close_exceptions for select to authenticated
  using (gc.is_office() and exists (select 1 from public.trips t
         where t.id = trip_close_exceptions.trip_id and t.org_id = gc.my_org()));

-- "View live location / trail": Owner, Accounts; Driver own only (D-029: no map in the driver app).
create policy pings_office_read on public.location_pings for select to authenticated
  using (org_id = gc.my_org() and gc.is_office());
create policy pings_driver_read on public.location_pings for select to authenticated
  using (user_id = auth.uid() and gc.has_role('driver'));
