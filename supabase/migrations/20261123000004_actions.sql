-- GC V1.0 · M2 · 0004 role-checked server actions: devices, trip state machine, trip close.
-- "Never trust the client for approvals" (Section 4): every function re-checks the caller's role.

-- Server-authored audit event for a state change (Section 3 "Audit trail of every event").
create function gc.write_status_event(p_trip public.trips, p_actor uuid, p_device uuid, p_to gc.trip_state,
                                      p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_now timestamptz := now();
begin
  insert into public.trip_events (id, org_id, trip_id, type, payload, actor_id, device_id, occurred_at, reason)
  values (v_id, p_trip.org_id, p_trip.id, 'TRIP_STATUS_CHANGED',
          jsonb_strip_nulls(jsonb_build_object('id', v_id, 'tripId', p_trip.id, 'type', 'TRIP_STATUS_CHANGED',
            'occurredAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'actorId', p_actor, 'from', p_trip.state, 'to', p_to, 'reason', p_reason)),
          p_actor, case when exists (select 1 from public.devices d where d.id = p_device) then p_device end,
          v_now, p_reason);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Devices (Section 4 "Authentication and devices")
-- ---------------------------------------------------------------------------------------------------------
create function public.register_device(p_device_id uuid, p_kind gc.device_kind, p_label text default null)
returns public.devices
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_org uuid; d public.devices;
begin
  perform gc.need(v_uid is not null, 'not signed in');
  select p.org_id into v_org from public.profiles p where p.user_id = v_uid and p.active;
  perform gc.need(v_org is not null, 'no active GC profile for this user');
  select * into d from public.devices where id = p_device_id;
  if found then
    perform gc.need(d.user_id = v_uid, 'device is registered to another user');
    perform gc.need(d.revoked_at is null, 'device has been revoked; ask the Owner');
    perform gc.need(d.kind = p_kind, 'device is already registered with another kind');
    return d;  -- idempotent
  end if;
  if p_kind = 'driver_phone' then
    perform gc.need(exists (select 1 from public.user_roles r where r.user_id = v_uid and r.role = 'driver'),
                    'only a Driver registers a driver phone');
  end if;
  insert into public.devices (id, org_id, user_id, kind, label) values (p_device_id, v_org, v_uid, p_kind, p_label)
  returning * into d;
  return d;
end $$;

-- "Create users, assign roles, revoke devices": Owner only. Takes effect at the phone's next contact.
create function public.revoke_device(p_device_id uuid, p_reason text) returns public.devices
language plpgsql security definer set search_path = '' as $$
declare d public.devices;
begin
  perform gc.need(gc.has_role('owner'), 'only the Owner revokes devices');
  perform gc.need(coalesce(p_reason, '') <> '', 'a reason is required');
  update public.devices set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = p_reason
  where id = p_device_id and org_id = gc.my_org() and revoked_at is null
  returning * into d;
  perform gc.need(found, 'unknown or already revoked device');
  return d;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Trip state machine (Section 4). CLOSED / CLOSED_WITH_EXCEPTIONS only via close_trip below.
-- D-011 (approved): Owner/Accounts DRAFT→LOADING; Warehouse LOADING→AWAITING_ACCEPTANCE; Driver (or
-- Owner/Accounts) DISPATCHED→RETURNED; Owner/Accounts RETURNED→RECONCILING and dispatch approval.
-- ---------------------------------------------------------------------------------------------------------
create function public.set_trip_state(p_trip_id uuid, p_to gc.trip_state, p_reason text default null)
returns public.trips
language plpgsql security definer set search_path = '' as $$
declare
  t public.trips;
  v_uid uuid := auth.uid();
  v_office boolean := gc.is_office();
  v_trip_driver boolean;
begin
  perform gc.need(v_uid is not null, 'not signed in');
  select * into t from public.trips where id = p_trip_id and org_id = gc.my_org() for update;
  perform gc.need(found, 'unknown trip');
  v_trip_driver := gc.has_role('driver') and t.driver_id = v_uid
                   and gc.on_driver_device(v_uid, gc.header_device_id());

  case
  when t.state = 'DRAFT' and p_to = 'LOADING' then
    perform gc.need(v_office, 'only Owner or Accounts starts loading');
  when t.state = 'LOADING' and p_to = 'AWAITING_ACCEPTANCE' then
    perform gc.need(gc.has_role('warehouse'), 'only Warehouse marks loading done');
    perform gc.need(exists (select 1 from public.handovers h where h.trip_id = t.id and h.kind = 'stock'
                            and h.direction = 'to_truck' and h.status <> 'reversed'),
                    'record the stock issue before marking loading done');
  when t.state = 'AWAITING_ACCEPTANCE' and p_to = 'DISPATCHED' then
    -- "Approve dispatch": Owner, Accounts. Requires the warehouse issue and a driver response to every handover.
    perform gc.need(v_office, 'only Owner or Accounts approves dispatch');
    perform gc.need(exists (select 1 from public.handovers h where h.trip_id = t.id and h.kind = 'stock'
                            and h.direction = 'to_truck' and h.status <> 'reversed'),
                    'the warehouse stock issue is not recorded');
    perform gc.need(not exists (select 1 from public.handovers h where h.trip_id = t.id
                                and h.direction = 'to_truck' and h.status = 'awaiting_response'),
                    'the driver has not responded to every handover');
    -- Safety-critical defects block dispatch: the departure checklist events arrive in M5 (STATE.md).
    update public.trips set business_date = (now() at time zone 'Africa/Harare')::date,  -- D-012 proposal
                            dispatched_at = now()
    where id = t.id;
  when t.state = 'DISPATCHED' and p_to = 'RETURNED' then
    perform gc.need(v_trip_driver or v_office, 'only the trip driver (or Owner/Accounts) marks the truck returned');
    update public.trips set returned_at = now() where id = t.id;
  when t.state = 'RETURNED' and p_to = 'RECONCILING' then
    perform gc.need(v_office, 'only Owner or Accounts starts reconciliation');
  else
    perform gc.need(false, format('a trip cannot move from %s to %s here', t.state, p_to));
  end case;

  perform gc.write_status_event(t, v_uid, gc.header_device_id(), p_to, p_reason);
  update public.trips set state = p_to where id = t.id returning * into t;
  return t;
end $$;

-- Close a trip. Called ONLY by the `close-trip` Edge Function (service role), which has verified the caller's
-- JWT and run the engine's close check (open items) on the server. The roles are checked again here.
-- Section 4B rule 3: closing verifies nothing by itself; it only checks everything is already signed off.
create function public.close_trip(p_trip_id uuid, p_actor uuid, p_aal2 boolean, p_device uuid, p_to gc.trip_state,
                                  p_open_items jsonb, p_assignments jsonb default '[]'::jsonb, p_reason text default null)
returns public.trips
language plpgsql security definer set search_path = '' as $$
declare
  t public.trips;
  v_roles gc.role[] := gc.roles_for(p_actor, p_device, p_aal2);
  v_org uuid;
  v_item jsonb;
  v_assign jsonb;
begin
  select p.org_id into v_org from public.profiles p where p.user_id = p_actor and p.active;
  select * into t from public.trips where id = p_trip_id and org_id = v_org for update;
  perform gc.need(found, 'unknown trip');
  perform gc.need(t.state = 'RECONCILING', 'only a trip in RECONCILING can be closed');
  perform gc.need(jsonb_typeof(p_open_items) = 'array', 'open items must be a list');

  if p_to = 'CLOSED' then
    -- "Close trip (CLOSED)": Owner, Accounts — and zero open differences.
    perform gc.need(v_roles && array['owner', 'accounts']::gc.role[], 'only Owner or Accounts closes a trip');
    perform gc.need(jsonb_array_length(p_open_items) = 0, 'the trip has open items: it can only be closed with exceptions');
    -- Defence in depth: nothing awaiting a second person may remain, whatever the caller says.
    perform gc.need(not exists (select 1 from public.payments p where p.trip_id = t.id and p.reversed_by is null
                                and p.verification_status in ('pending', 'rejected')), 'payments are not verified');
    perform gc.need(not exists (select 1 from public.expenses x where x.trip_id = t.id and x.reversed_by is null
                                and x.approval_status <> 'approved'), 'expenses are not all approved');
    perform gc.need(not exists (select 1 from public.handovers h where h.trip_id = t.id and h.status <> 'reversed'
                                and h.status <> 'accepted'), 'handovers are not all accepted');
  elsif p_to = 'CLOSED_WITH_EXCEPTIONS' then
    -- "Close with exceptions": Owner only; every open item gets an owner and a due date.
    perform gc.need('owner' = any (v_roles), 'only the Owner closes a trip with exceptions');
    perform gc.need(jsonb_array_length(p_open_items) > 0, 'there are no open items: close the trip normally');
    for v_item in select * from jsonb_array_elements(p_open_items) loop
      select a into v_assign from jsonb_array_elements(p_assignments) a where a ->> 'itemRef' = v_item ->> 'ref';
      perform gc.need(v_assign is not null, format('open item %s has no owner and due date', v_item ->> 'ref'));
      perform gc.need(exists (select 1 from public.profiles p where p.user_id = (v_assign ->> 'assignedTo')::uuid
                              and p.org_id = v_org and p.active), 'assigned person is not in this organisation');
      insert into public.trip_close_exceptions (trip_id, item_ref, kind, detail, assigned_to, due_date, created_by)
      values (t.id, v_item ->> 'ref', v_item ->> 'kind', v_item ->> 'detail', (v_assign ->> 'assignedTo')::uuid,
              (v_assign ->> 'dueDate')::date, p_actor);
    end loop;
  else
    perform gc.need(false, 'close_trip only moves a trip to CLOSED or CLOSED_WITH_EXCEPTIONS');
  end if;

  perform gc.write_status_event(t, p_actor, p_device, p_to, p_reason);
  update public.trips set state = p_to, closed_at = now() where id = t.id returning * into t;
  return t;
end $$;

revoke execute on function public.register_device(uuid, gc.device_kind, text) from public, anon;
revoke execute on function public.revoke_device(uuid, text) from public, anon;
revoke execute on function public.set_trip_state(uuid, gc.trip_state, text) from public, anon;
revoke execute on function public.close_trip(uuid, uuid, boolean, uuid, gc.trip_state, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.register_device(uuid, gc.device_kind, text) to authenticated;
grant execute on function public.revoke_device(uuid, text) to authenticated;
grant execute on function public.set_trip_state(uuid, gc.trip_state, text) to authenticated;
grant execute on function public.close_trip(uuid, uuid, boolean, uuid, gc.trip_state, jsonb, jsonb, text)
  to service_role;

-- Internal helpers are not callable through the API by clients.
revoke execute on all functions in schema gc from public;
grant execute on all functions in schema gc to authenticated, service_role;
revoke execute on function gc.post_event(jsonb, uuid, uuid, gc.role[], public.devices, boolean, uuid) from authenticated;
revoke execute on function gc.project_event(public.trip_events) from authenticated;
revoke execute on function gc.rebuild_projections(uuid) from authenticated;
revoke execute on function gc.write_status_event(public.trips, uuid, uuid, gc.trip_state, text) from authenticated;
revoke execute on function gc.log_exception(uuid, text, text, uuid, uuid, uuid, text, jsonb) from authenticated;
