-- GC V1.0 · M2 · 0003 idempotent event ingestion, server-side permission checks, cost snapshots, projections.
--
-- public.ingest_events(batch) is called by the `ingest-events` Edge Function WITH THE USER'S JWT, so auth.uid()
-- is the real user. Each event is posted in its own sub-transaction: a sale bundle (sale + lines + payments +
-- cost snapshots + projections) is all-or-nothing (Scenario D4), and one bad event never blocks the rest.
--
-- Outcomes per event: accepted | duplicate (same id, same content — Section 2 #8) | conflict (same id,
-- different content — D3, raises a visible exception) | rejected (rule broken — D4, visible exception) |
-- quarantined (revoked device — Scenario E).

-- ---------------------------------------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------------------------------------
create function gc.need(p_ok boolean, p_msg text) returns void
language plpgsql immutable as $$
begin
  if p_ok is not true then raise exception '%', p_msg using errcode = 'P0001'; end if;
end $$;

-- Integer minor units from a JSON money object; never a float (Section 2 #4).
create function gc.minor(p_money jsonb) returns bigint
language plpgsql immutable as $$
declare v numeric;
begin
  perform gc.need(jsonb_typeof(p_money -> 'minor') = 'number', 'money.minor must be a number');
  v := (p_money ->> 'minor')::numeric;
  perform gc.need(v = trunc(v) and v >= 0, 'money.minor must be a non-negative integer');
  return v::bigint;
end $$;

create function gc.ccy(p_money jsonb) returns gc.currency
language plpgsql immutable as $$
begin
  perform gc.need(p_money ->> 'currency' in ('USD', 'ZWG'), 'unknown currency');
  return (p_money ->> 'currency')::gc.currency;
end $$;

-- FX conversion with exact integer arithmetic, rounding half away from zero (D-041, same as the engine).
-- Rate: 1 rate.from = rate.rate rate.to.
create function gc.fx_convert(p_minor bigint, p_from gc.currency, p_to gc.currency, p_rate jsonb,
                              out minor bigint, out exact boolean)
language plpgsql immutable as $$
declare s text; num numeric; den numeric; n numeric; d numeric; q numeric; r numeric;
begin
  if p_from = p_to then minor := p_minor; exact := true; return; end if;
  perform gc.need(p_rate is not null, format('an FX rate is needed to convert %s to %s', p_from, p_to));
  s := p_rate ->> 'rate';
  perform gc.need(s ~ '^\d+(\.\d+)?$' and s !~ '^0+(\.0+)?$', 'FX rate must be a positive decimal string');
  perform gc.need(coalesce(p_rate ->> 'source', '') <> '', 'FX rate needs a source');
  num := replace(s, '.', '')::numeric;
  den := 10::numeric ^ coalesce(length(split_part(s, '.', 2)), 0);
  if p_rate ->> 'from' = p_from::text and p_rate ->> 'to' = p_to::text then n := p_minor * num; d := den;
  elsif p_rate ->> 'from' = p_to::text and p_rate ->> 'to' = p_from::text then n := p_minor * den; d := num;
  else perform gc.need(false, format('FX rate %s→%s cannot convert %s to %s',
                                     p_rate ->> 'from', p_rate ->> 'to', p_from, p_to));
  end if;
  q := div(n, d); r := mod(n, d);
  minor := (q + case when r * 2 >= d then 1 else 0 end)::bigint;
  exact := r = 0;
end $$;

create function gc.log_exception(p_org uuid, p_kind text, p_event_id text, p_trip uuid, p_user uuid,
                                 p_device uuid, p_detail text, p_raw jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.ingest_exceptions (org_id, kind, event_id, trip_id, user_id, device_id, detail, raw)
  select p_org, p_kind, p_event_id, p_trip, p_user, p_device, p_detail, p_raw
  where not exists (select 1 from public.ingest_exceptions x
                    where x.kind = p_kind and x.event_id is not distinct from p_event_id
                      and x.detail = p_detail and x.resolved_at is null)
$$;

create function gc.reversed_ids(p_trip uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select e.reverses_event_id from public.trip_events e
  where e.trip_id = p_trip and e.type = 'EVENT_REVERSED'
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Payments (shared by sales and debt collections). Returns the net amount converted to p_sale_ccy and
-- the number of inexact conversions.
-- ---------------------------------------------------------------------------------------------------------
create function gc.check_payments(p_payments jsonb, p_sale_ccy gc.currency, p_allow_credit boolean,
                                  out paid bigint, out inexact int)
language plpgsql stable as $$
declare p jsonb; amt bigint; chg bigint; ccy gc.currency; conv record;
begin
  paid := 0; inexact := 0;
  perform gc.need(jsonb_typeof(p_payments) = 'array' and jsonb_array_length(p_payments) > 0,
                  'at least one payment is required');
  for p in select * from jsonb_array_elements(p_payments) loop
    perform gc.need(p ->> 'tender' in ('cash', 'ecocash', 'swipe', 'transfer', 'credit'), 'unknown tender');
    perform gc.need(p_allow_credit or p ->> 'tender' <> 'credit', 'a collection cannot be paid on credit');
    amt := gc.minor(p -> 'amount');
    ccy := gc.ccy(p -> 'amount');
    chg := 0;
    if p ? 'change' then
      chg := gc.minor(p -> 'change');
      perform gc.need(gc.ccy(p -> 'change') = ccy, 'change must be in the tender currency (D-021)');
      perform gc.need(chg <= amt, 'change cannot exceed the amount');
      perform gc.need(chg = 0 or p ->> 'tender' = 'cash', 'only cash gives change');
    end if;
    conv := gc.fx_convert(amt - chg, ccy, p_sale_ccy, p -> 'fxRate');
    paid := paid + conv.minor;
    if not conv.exact then inexact := inexact + 1; end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Server-side permission and rule checks per event type (Section 4B, mirrors permissions.ts).
-- p_roles are the effective roles for this request (D-027 driver phone; Owner needs aal2).
-- ---------------------------------------------------------------------------------------------------------
create function gc.check_event(p_ev jsonb, p_trip public.trips, p_roles gc.role[], p_uid uuid,
                               p_dev public.devices) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_type text := p_ev ->> 'type';
  v_state gc.trip_state := p_trip.state;
  v_dir text := p_ev ->> 'direction';
  v_office boolean := p_roles && array['owner', 'accounts']::gc.role[];
  v_owner boolean := 'owner' = any (p_roles);
  v_accounts boolean := 'accounts' = any (p_roles);
  v_warehouse boolean := 'warehouse' = any (p_roles);
  -- A driver acts only on their own trip, from their own registered driver phone (Section 4 devices).
  v_trip_driver boolean := 'driver' = any (p_roles) and p_trip.driver_id = p_uid
                           and p_dev.id is not null and p_dev.kind = 'driver_phone';
  v_open boolean := p_trip.state not in ('CLOSED', 'CLOSED_WITH_EXCEPTIONS');
  h public.handovers;
  x public.expenses;
  pay public.payments;
  tgt public.trip_events;
  v_total bigint; v_line jsonb; v_ccy gc.currency; v_list_ccy gc.currency; chk record;
  v_disc bigint; v_pct numeric; v_limit bigint;
begin
  case v_type
  when 'STOCK_HANDOVER_ISSUED', 'CASH_HANDOVER_ISSUED' then
    perform gc.need((p_ev ->> 'issuerId')::uuid = p_uid, 'issuerId must be the signed-in user');
    perform gc.need(not exists (select 1 from public.handovers where id = (p_ev ->> 'handoverId')::uuid),
                    'this handover was already issued');
    perform gc.need(v_dir in ('to_truck', 'from_truck'), 'unknown handover direction');
    if v_type = 'STOCK_HANDOVER_ISSUED' and v_dir = 'to_truck' then
      -- "Record stock issue to truck": Warehouse only, while loading.
      perform gc.need(v_warehouse, 'only Warehouse records a stock issue to the truck');
      perform gc.need(v_state = 'LOADING', 'stock is issued while the trip is LOADING');
    elsif v_type = 'STOCK_HANDOVER_ISSUED' then
      -- "Count returned stock": Warehouse and Driver, both sides required.
      perform gc.need(v_warehouse or v_trip_driver, 'only Warehouse or the trip driver counts returned stock');
      perform gc.need(v_state in ('RETURNED', 'RECONCILING'), 'returned stock is counted after RETURNED');
    elsif v_dir = 'to_truck' then
      -- "Issue cash float / fuel money": Owner, Accounts.
      perform gc.need(v_office, 'only Owner or Accounts issues cash to the truck');
      perform gc.need(v_state in ('LOADING', 'AWAITING_ACCEPTANCE'), 'cash is issued before dispatch');
    else
      -- Driver hands over cash at trip end.
      perform gc.need(v_trip_driver, 'only the trip driver hands over cash at the end of the trip');
      perform gc.need(v_state in ('RETURNED', 'RECONCILING'), 'cash is handed over after RETURNED');
    end if;
    perform gc.need(jsonb_array_length(p_ev -> 'lines') > 0, 'a handover needs at least one line');
    if v_type = 'STOCK_HANDOVER_ISSUED' then
      perform gc.need(not exists (select 1 from jsonb_array_elements(p_ev -> 'lines') l
                                  where not exists (select 1 from public.products pr
                                                    where pr.id = (l ->> 'productId')::uuid and pr.org_id = p_trip.org_id)),
                      'unknown product in handover');
    else
      perform gc.minor(l -> 'amount') from jsonb_array_elements(p_ev -> 'lines') l;
    end if;

  when 'STOCK_HANDOVER_RESPONDED', 'CASH_HANDOVER_RESPONDED' then
    select * into h from public.handovers where id = (p_ev ->> 'handoverId')::uuid and trip_id = p_trip.id;
    perform gc.need(found, 'unknown handover');
    perform gc.need(h.kind = case when v_type like 'STOCK%' then 'stock' else 'cash' end, 'handover kind mismatch');
    perform gc.need(h.response is null, 'this handover already has a response');
    perform gc.need((p_ev ->> 'receiverId')::uuid = p_uid, 'receiverId must be the signed-in user');
    -- Separation of duties rule 1: no self-acceptance.
    perform gc.need(h.issuer_id <> p_uid, 'the issuer of a handover cannot also receive it (no self-acceptance)');
    perform gc.need(p_ev ->> 'response' in ('accept', 'accept_discrepancy', 'dispute'), 'unknown response');
    if h.direction = 'to_truck' then
      -- "Accept / dispute handovers at departure": Driver, own trip.
      perform gc.need(v_trip_driver, 'only the trip driver accepts or disputes departure handovers');
      perform gc.need(v_state = 'AWAITING_ACCEPTANCE', 'departure handovers are answered while AWAITING_ACCEPTANCE');
    elsif h.kind = 'stock' then
      perform gc.need(v_warehouse or v_trip_driver, 'only Warehouse or the trip driver counts returned stock');
      perform gc.need(v_state in ('RETURNED', 'RECONCILING'), 'returned stock is counted after RETURNED');
    else
      -- "Receive cash handover": Owner, Accounts.
      perform gc.need(v_office, 'only Owner or Accounts receives the cash handover');
      perform gc.need(v_state in ('RETURNED', 'RECONCILING'), 'cash is received after RETURNED');
    end if;
    if v_type = 'CASH_HANDOVER_RESPONDED' then
      perform gc.minor(l -> 'amount') from jsonb_array_elements(p_ev -> 'lines') l;
    end if;

  when 'SALE_RECORDED', 'DEBT_COLLECTED' then
    -- "Record sales, payments, collections": Driver, own DISPATCHED trip only.
    perform gc.need(v_trip_driver, 'only the trip driver records sales and collections, from the driver phone');
    perform gc.need(v_state = 'DISPATCHED', 'sales and collections are recorded only while the trip is DISPATCHED');
    perform gc.need(exists (select 1 from public.customers c where c.id = (p_ev ->> 'customerId')::uuid
                            and c.org_id = p_trip.org_id), 'unknown customer');
    select l.currency into v_list_ccy from public.price_lists l where l.id = p_trip.price_list_id;
    if v_type = 'DEBT_COLLECTED' then
      chk := gc.check_payments(p_ev -> 'payments', v_list_ccy, false);
      return;
    end if;
    v_total := 0;
    perform gc.need(jsonb_array_length(p_ev -> 'lines') > 0, 'a sale needs at least one line');
    for v_line in select * from jsonb_array_elements(p_ev -> 'lines') loop
      perform gc.need(not (v_line ? 'unitCostSnapshot'), 'cost snapshots are written by the server only');
      perform gc.need(jsonb_typeof(v_line -> 'qty') = 'number' and (v_line ->> 'qty')::numeric > 0
                      and (v_line ->> 'qty')::numeric = trunc((v_line ->> 'qty')::numeric), 'qty must be a positive integer');
      perform gc.need(exists (select 1 from public.price_list_items i where i.price_list_id = p_trip.price_list_id
                              and i.product_id = (v_line ->> 'productId')::uuid),
                      'product is not on this trip''s price list');
      v_ccy := gc.ccy(v_line -> 'unitPrice');
      perform gc.need(v_ccy = v_list_ccy, 'sale lines must be priced in the price list currency (D-020)');
      v_total := v_total + (v_line ->> 'qty')::bigint * gc.minor(v_line -> 'unitPrice');
    end loop;
    if p_ev ? 'discount' and gc.minor(p_ev -> 'discount') > 0 then
      -- "Discount / price override": off by default; only within the Owner-set % limit.
      v_disc := gc.minor(p_ev -> 'discount');
      perform gc.need(gc.ccy(p_ev -> 'discount') = v_list_ccy, 'discount must be in the sale currency');
      select s.driver_discount_max_pct into v_pct from public.org_settings s where s.org_id = p_trip.org_id;
      perform gc.need(v_pct is not null, 'discounts are switched off (Owner has not set a discount limit)');
      perform gc.need(v_disc * 100 <= v_pct * v_total, 'discount is above the Owner-set limit');
      v_total := v_total - v_disc;
    end if;
    chk := gc.check_payments(p_ev -> 'payments', v_list_ccy, true);
    -- Inexact FX conversions may each be off by 1 minor unit after rounding (D-041).
    perform gc.need(abs(chk.paid - v_total) <= chk.inexact,
                    format('payments (%s) do not add up to the sale total (%s)', chk.paid, v_total));

  when 'CUSTOMER_CREATED' then
    -- "Create customer": Driver only during a sale on their own trip. Office creates customers directly.
    perform gc.need(v_trip_driver, 'only the trip driver creates customers through the driver app');
    perform gc.need(v_state = 'DISPATCHED', 'customers are created during sales on a DISPATCHED trip');
    perform gc.need(not exists (select 1 from public.customers where id = (p_ev ->> 'customerId')::uuid),
                    'customer id already exists');

  when 'EXPENSE_REPORTED' then
    perform gc.minor(p_ev -> 'amount');
    perform gc.ccy(p_ev -> 'amount');
    perform gc.need(p_ev ->> 'paidFrom' in ('driver_cash', 'office', 'unpaid'), 'unknown paidFrom');
    if v_trip_driver then
      -- "Report trip expense": Driver.
      perform gc.need(v_state = 'DISPATCHED', 'the driver reports expenses while the trip is DISPATCHED');
    else
      -- D-050 (OPEN, interim): Owner/Accounts may record an office-paid trip expense such as the allowance.
      perform gc.need(v_office and p_ev ->> 'paidFrom' = 'office',
                      'only the trip driver reports trip expenses (office-paid expenses: Owner/Accounts, D-050)');
      perform gc.need(v_open and v_state <> 'DRAFT', 'trip is not open for expenses');
    end if;

  when 'EXPENSE_REVIEWED' then
    select * into x from public.expenses where id = (p_ev ->> 'expenseId')::uuid and trip_id = p_trip.id;
    perform gc.need(found and x.reversed_by is null, 'unknown expense');
    perform gc.need(p_ev ->> 'decision' in ('evidence_reviewed', 'approved', 'disputed'), 'unknown decision');
    perform gc.need(v_open, 'trip is closed');
    -- Separation of duties rule 2: no self-approval of the specific item.
    perform gc.need(x.reported_by <> p_uid, 'you cannot review an expense you reported (goes to another person)');
    perform gc.need(x.approval_status not in ('approved', 'disputed'),
                    'this expense is already decided; record a reversal to change it');
    if not v_owner then
      perform gc.need(v_accounts, 'only Owner or Accounts reviews expenses');
      if p_ev ->> 'decision' <> 'evidence_reviewed' then
        select l.max_minor into v_limit from public.expense_approval_limits l
        where l.org_id = p_trip.org_id and l.currency = x.currency;
        perform gc.need(v_limit is not null and x.amount_minor <= v_limit,
                        'above the Accounts approval limit: needs the Owner');
      end if;
    end if;

  when 'PAYMENT_VERIFIED' then
    -- "Verify EcoCash / swipe / transfer": Owner, Accounts; never the person who recorded the payment.
    perform gc.need(v_office, 'only Owner or Accounts verifies payments');
    select * into pay from public.payments where id = (p_ev ->> 'paymentId')::uuid and trip_id = p_trip.id;
    perform gc.need(found and pay.reversed_by is null, 'unknown payment');
    perform gc.need(pay.tender in ('ecocash', 'swipe', 'transfer'), 'only EcoCash, swipe and transfer are verified');
    perform gc.need(pay.recorded_by <> p_uid, 'you cannot verify a payment you recorded');
    perform gc.need(pay.verification_status = 'pending', 'this payment is already verified or rejected');
    perform gc.need(p_ev ->> 'result' in ('verified', 'rejected'), 'unknown result');

  when 'STOCK_DAMAGED' then
    -- D-052 (OPEN): who records damage. Interim: driver on the road, warehouse at return.
    perform gc.need((v_trip_driver and v_state = 'DISPATCHED')
                    or (v_warehouse and v_state in ('RETURNED', 'RECONCILING')),
                    'damage is recorded by the trip driver (DISPATCHED) or Warehouse (at return)');
    perform gc.need(exists (select 1 from public.products pr where pr.id = (p_ev ->> 'productId')::uuid
                            and pr.org_id = p_trip.org_id), 'unknown product');

  when 'FUEL_READING' then
    perform gc.need(v_trip_driver, 'only the trip driver records fuel readings');
    perform gc.need(v_state in ('AWAITING_ACCEPTANCE', 'DISPATCHED', 'RETURNED'), 'trip is not on the road');

  when 'EVENT_REVERSED' then
    perform gc.need(coalesce(p_ev ->> 'reason', '') <> '', 'a correction needs a reason');
    perform gc.need(v_open, 'trip is closed');
    select * into tgt from public.trip_events where id = (p_ev ->> 'reversesEventId')::uuid and trip_id = p_trip.id;
    perform gc.need(found, 'unknown event to reverse');
    perform gc.need(tgt.type not in ('EVENT_REVERSED', 'TRIP_STATUS_CHANGED'), 'this event cannot be reversed');
    perform gc.need(tgt.id not in (select gc.reversed_ids(p_trip.id)), 'this event is already reversed');
    -- "Record correction / reversal event": Owner; Accounts (with reason); Warehouse own stock events;
    -- Driver: after sync, request a correction (D-030).
    if not v_office then
      perform gc.need(v_warehouse and tgt.actor_id = p_uid
                      and tgt.type in ('STOCK_HANDOVER_ISSUED', 'STOCK_HANDOVER_RESPONDED', 'STOCK_DAMAGED'),
                      'not allowed to reverse this event (drivers request a correction from the office)');
    end if;

  when 'LOSS_CONFIRMED' then
    -- Section 2 #10: only the Owner marks "Confirmed loss".
    perform gc.need(v_owner, 'only the Owner confirms a loss');
    perform gc.need(v_state in ('RECONCILING', 'CLOSED_WITH_EXCEPTIONS'), 'losses are confirmed during reconciliation');

  else
    perform gc.need(false, format('event type %s cannot be sent by a client', coalesce(v_type, 'null')));
  end case;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Projections
-- ---------------------------------------------------------------------------------------------------------
create function gc.refresh_expense(p_expense uuid) returns void
language sql security definer set search_path = '' as $$
  update public.expenses x set
    approval_status = coalesce(r.decision, 'pending'),
    reviewed_by = r.actor_id
  from (select null::text as decision, null::uuid as actor_id) dflt
  left join lateral (
    select e.payload ->> 'decision' as decision, e.actor_id from public.trip_events e
    where e.type = 'EXPENSE_REVIEWED' and (e.payload ->> 'expenseId')::uuid = p_expense
      and e.id not in (select gc.reversed_ids(e.trip_id))
    order by e.seq desc limit 1) r on true
  where x.id = p_expense
$$;

create function gc.refresh_payment(p_payment uuid) returns void
language sql security definer set search_path = '' as $$
  update public.payments p set verification_status = coalesce(r.result, 'pending')
  from (select 1) dflt
  left join lateral (
    select e.payload ->> 'result' as result from public.trip_events e
    where e.type = 'PAYMENT_VERIFIED' and (e.payload ->> 'paymentId')::uuid = p_payment
      and e.id not in (select gc.reversed_ids(e.trip_id))
    order by e.seq desc limit 1) r on true
  where p.id = p_payment and p.tender in ('ecocash', 'swipe', 'transfer')
$$;

create function gc.insert_payments(e public.trip_events, p_sale uuid, p_collection uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.payments (id, trip_id, event_id, sale_id, collection_id, customer_id, recorded_by, tender,
    currency, amount_minor, change_minor, fx_rate_decimal, fx_rate_id, reference, verification_status)
  select (p ->> 'paymentId')::uuid, e.trip_id, e.id, p_sale, p_collection, (e.payload ->> 'customerId')::uuid,
    e.actor_id, p ->> 'tender', (p -> 'amount' ->> 'currency')::gc.currency, (p -> 'amount' ->> 'minor')::bigint,
    coalesce((p -> 'change' ->> 'minor')::bigint, 0), p -> 'fxRate' ->> 'rate', (p -> 'fxRate' ->> 'rateId')::uuid,
    p ->> 'reference',
    case when p ->> 'tender' in ('ecocash', 'swipe', 'transfer') then 'pending' else 'not_required' end
  from jsonb_array_elements(e.payload -> 'payments') p
$$;

create function gc.project_event(e public.trip_events) returns void
language plpgsql security definer set search_path = '' as $$
declare v jsonb := e.payload; tgt public.trip_events; v_total bigint;
begin
  case e.type
  when 'STOCK_HANDOVER_ISSUED', 'CASH_HANDOVER_ISSUED' then
    insert into public.handovers (id, trip_id, kind, direction, issuer_id, issuer_lines, issued_event_id)
    values ((v ->> 'handoverId')::uuid, e.trip_id, case when e.type like 'STOCK%' then 'stock' else 'cash' end,
            v ->> 'direction', (v ->> 'issuerId')::uuid, v -> 'lines', e.id);
  when 'STOCK_HANDOVER_RESPONDED', 'CASH_HANDOVER_RESPONDED' then
    update public.handovers set receiver_id = (v ->> 'receiverId')::uuid, receiver_lines = v -> 'lines',
      responded_event_id = e.id, response = v ->> 'response',
      status = case v ->> 'response' when 'accept' then 'accepted'
                 when 'accept_discrepancy' then 'accepted_with_discrepancy' else 'disputed' end
    where id = (v ->> 'handoverId')::uuid;
  when 'SALE_RECORDED' then
    select sum((l ->> 'qty')::bigint * (l -> 'unitPrice' ->> 'minor')::bigint) into v_total
    from jsonb_array_elements(v -> 'lines') l;
    insert into public.sales (id, event_id, trip_id, customer_id, total_minor, currency, occurred_at)
    values ((v ->> 'saleId')::uuid, e.id, e.trip_id, (v ->> 'customerId')::uuid,
            v_total - coalesce((v -> 'discount' ->> 'minor')::bigint, 0),
            (v -> 'lines' -> 0 -> 'unitPrice' ->> 'currency')::gc.currency, e.occurred_at);
    insert into public.sale_lines (sale_id, line_id, product_id, qty_base_units, unit_price_minor, currency)
    select (v ->> 'saleId')::uuid, (l ->> 'lineId')::uuid, (l ->> 'productId')::uuid, (l ->> 'qty')::int,
           (l -> 'unitPrice' ->> 'minor')::bigint, (l -> 'unitPrice' ->> 'currency')::gc.currency
    from jsonb_array_elements(v -> 'lines') l;
    perform gc.insert_payments(e, (v ->> 'saleId')::uuid, null);
  when 'DEBT_COLLECTED' then
    perform gc.insert_payments(e, null, (v ->> 'collectionId')::uuid);
  when 'EXPENSE_REPORTED' then
    insert into public.expenses (id, trip_id, event_id, reported_by, category, amount_minor, currency, paid_from,
                                 receipt_photo_path)
    values ((v ->> 'expenseId')::uuid, e.trip_id, e.id, e.actor_id, v ->> 'category',
            (v -> 'amount' ->> 'minor')::bigint, (v -> 'amount' ->> 'currency')::gc.currency, v ->> 'paidFrom',
            v ->> 'receiptPhotoPath');
  when 'EXPENSE_REVIEWED' then
    perform gc.refresh_expense((v ->> 'expenseId')::uuid);
  when 'PAYMENT_VERIFIED' then
    perform gc.refresh_payment((v ->> 'paymentId')::uuid);
  when 'EVENT_REVERSED' then
    select * into tgt from public.trip_events where id = e.reverses_event_id;
    case tgt.type
    when 'SALE_RECORDED' then
      update public.sales set reversed_by = e.id where id = (tgt.payload ->> 'saleId')::uuid;
      update public.payments set reversed_by = e.id where event_id = tgt.id;
    when 'DEBT_COLLECTED' then
      update public.payments set reversed_by = e.id where event_id = tgt.id;
    when 'EXPENSE_REPORTED' then
      update public.expenses set reversed_by = e.id where event_id = tgt.id;
    when 'EXPENSE_REVIEWED' then
      perform gc.refresh_expense((tgt.payload ->> 'expenseId')::uuid);
    when 'PAYMENT_VERIFIED' then
      perform gc.refresh_payment((tgt.payload ->> 'paymentId')::uuid);
    when 'STOCK_HANDOVER_ISSUED', 'CASH_HANDOVER_ISSUED' then
      update public.handovers set status = 'reversed' where issued_event_id = tgt.id;
    when 'STOCK_HANDOVER_RESPONDED', 'CASH_HANDOVER_RESPONDED' then
      update public.handovers set receiver_id = null, receiver_lines = null, responded_event_id = null,
        response = null, status = 'awaiting_response' where responded_event_id = tgt.id;
    else null;
    end case;
  else null;  -- fuel readings, damage, customer creation, losses, status changes: read from events directly
  end case;
end $$;

-- Section 4: projections can be rebuilt from events at any time. Service role / tests only.
create function gc.rebuild_projections(p_trip uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.trip_events;
begin
  delete from public.payments where trip_id = p_trip;
  delete from public.sale_lines where sale_id in (select id from public.sales where trip_id = p_trip);
  delete from public.sales where trip_id = p_trip;
  delete from public.expenses where trip_id = p_trip;
  delete from public.handovers where trip_id = p_trip;
  for e in select * from public.trip_events where trip_id = p_trip order by seq loop
    perform gc.project_event(e);
  end loop;
end $$;
revoke execute on function gc.rebuild_projections(uuid) from public, authenticated;
grant execute on function gc.rebuild_projections(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- Posting one event
-- ---------------------------------------------------------------------------------------------------------
create function gc.post_event(p_ev jsonb, p_uid uuid, p_org uuid, p_roles gc.role[], p_dev public.devices,
                              p_skew boolean, p_batch uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid; v_existing jsonb; v_trip public.trips; e public.trip_events; v_line jsonb; v_cost public.product_costs;
  v_asof timestamptz; v_dup uuid; v_list_price bigint; v_cust public.customers; v_credit bigint; v_owed bigint;
begin
  perform gc.need(jsonb_typeof(p_ev) = 'object', 'event must be an object');
  begin
    v_id := (p_ev ->> 'id')::uuid;
  exception when others then
    perform gc.need(false, 'event id must be a UUID');
  end;
  perform gc.need(v_id is not null, 'event id is required');

  -- Idempotency (Section 2 #8) and conflicting resubmission (D3): checked before anything else.
  select payload into v_existing from public.trip_events where id = v_id;
  if found then
    if v_existing = p_ev then return jsonb_build_object('id', v_id, 'status', 'duplicate'); end if;
    perform gc.log_exception(p_org, 'conflicting_resubmission', v_id::text, (p_ev ->> 'tripId')::uuid, p_uid,
      p_dev.id, 'Conflicting resubmission: same event id, different contents. The first version is kept.', p_ev);
    return jsonb_build_object('id', v_id, 'status', 'conflict',
      'error', 'Conflicting resubmission: this event id already exists with different contents');
  end if;

  select * into v_trip from public.trips where id = (p_ev ->> 'tripId')::uuid and org_id = p_org for update;
  perform gc.need(found, 'unknown trip');
  perform gc.need((p_ev ->> 'actorId')::uuid = p_uid, 'actorId must be the signed-in user');
  perform gc.need(not (p_ev ? 'deviceId') or (p_ev ->> 'deviceId')::uuid = p_dev.id,
                  'deviceId does not match the uploading device');
  perform gc.need((p_ev ->> 'occurredAt') is not null, 'occurredAt is required');

  perform gc.check_event(p_ev, v_trip, p_roles, p_uid, p_dev);

  insert into public.trip_events (id, org_id, trip_id, type, payload, actor_id, device_id, occurred_at, batch_id,
                                  reverses_event_id, reason, clock_skew)
  values (v_id, p_org, v_trip.id, p_ev ->> 'type', p_ev, p_uid, p_dev.id, (p_ev ->> 'occurredAt')::timestamptz,
          p_batch, (p_ev ->> 'reversesEventId')::uuid, p_ev ->> 'reason', p_skew)
  returning * into e;

  if e.type = 'SALE_RECORDED' then
    -- Section 4 "Cost version for offline sales": cost effective at occurred_at, or at received_at when the
    -- device clock is skewed (and Accounts reviews it). Written once, never rewritten.
    v_asof := case when p_skew then e.received_at else e.occurred_at end;
    for v_line in select * from jsonb_array_elements(p_ev -> 'lines') loop
      select * into v_cost from public.product_costs c
      where c.product_id = (v_line ->> 'productId')::uuid and c.effective_from <= v_asof
      order by c.effective_from desc limit 1;
      if found then
        insert into public.sale_line_costs (event_id, line_id, product_id, unit_cost_minor, currency, product_cost_id,
                                            cost_as_of, as_of_basis)
        values (e.id, (v_line ->> 'lineId')::uuid, v_cost.product_id, v_cost.unit_cost_minor, v_cost.currency,
                v_cost.id, v_asof, case when p_skew then 'received_at' else 'occurred_at' end);
      else
        perform gc.log_exception(p_org, 'missing_cost', e.id::text, e.trip_id, p_uid, p_dev.id,
          format('no cost on file for product %s at %s', v_line ->> 'productId', v_asof), null);
      end if;
      select i.unit_price_minor into v_list_price from public.price_list_items i
      where i.price_list_id = v_trip.price_list_id and i.product_id = (v_line ->> 'productId')::uuid;
      if v_list_price is distinct from (v_line -> 'unitPrice' ->> 'minor')::bigint then
        perform gc.log_exception(p_org, 'price_mismatch', e.id::text, e.trip_id, p_uid, p_dev.id,
          format('line %s sold at %s, price list says %s (D-053)', v_line ->> 'lineId',
                 v_line -> 'unitPrice' ->> 'minor', v_list_price), null);
      end if;
    end loop;
    -- Credit within the customer's limit (Section 4B "Credit sale"). The phone enforces its cached limit;
    -- the server never drops a real sale, it raises an exception for Accounts instead (D-023 / D-054).
    select coalesce(sum((p -> 'amount' ->> 'minor')::bigint), 0) into v_credit
    from jsonb_array_elements(p_ev -> 'payments') p where p ->> 'tender' = 'credit';
    if v_credit > 0 then
      select * into v_cust from public.customers where id = (p_ev ->> 'customerId')::uuid;
      select coalesce(sum(case when py.tender = 'credit' then py.amount_minor
                               when py.collection_id is not null then -(py.amount_minor - py.change_minor) else 0 end), 0)
        into v_owed
      from public.payments py where py.customer_id = v_cust.id and py.currency = v_cust.credit_currency
        and py.reversed_by is null;
      if v_cust.credit_limit_minor is null or v_owed + v_credit > v_cust.credit_limit_minor then
        perform gc.log_exception(p_org, 'credit_over_limit', e.id::text, e.trip_id, p_uid, p_dev.id,
          format('credit %s takes customer %s to %s; limit %s', v_credit, v_cust.id, v_owed + v_credit,
                 coalesce(v_cust.credit_limit_minor::text, 'not set')), null);
      end if;
    end if;
  elsif e.type = 'CUSTOMER_CREATED' then
    select c.id into v_dup from public.customers c
    where c.org_id = p_org and c.merged_into_id is null
      and c.phone_digits = nullif(regexp_replace(coalesce(p_ev ->> 'phone', ''), '\D', '', 'g'), '')
    order by c.created_at limit 1;
    insert into public.customers (id, org_id, name, phone, lat, lng, business_type, created_on_trip_id, created_by,
                                  possible_duplicate_of)
    values ((p_ev ->> 'customerId')::uuid, p_org, p_ev ->> 'name', p_ev ->> 'phone', (p_ev ->> 'lat')::float8,
            (p_ev ->> 'lng')::float8, p_ev ->> 'businessType', e.trip_id, p_uid, v_dup);
    if v_dup is not null then
      -- Scenario D5: flagged as a possible duplicate; merging is for Accounts, never automatic.
      perform gc.log_exception(p_org, 'possible_duplicate_customer', e.id::text, e.trip_id, p_uid, p_dev.id,
        format('customer %s has the same phone as %s', p_ev ->> 'customerId', v_dup), null);
    end if;
  end if;

  perform gc.project_event(e);

  if p_skew then
    perform gc.log_exception(p_org, 'clock_skew_review', e.id::text, e.trip_id, p_uid, p_dev.id,
      'device clock differed from server time at upload (D-024)', null);
  end if;
  return jsonb_build_object('id', v_id, 'status', 'accepted');
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- The ingestion entry point
-- ---------------------------------------------------------------------------------------------------------
-- p_rejections: {eventId: reason} for events the Edge Function already refused (Zod / UUID checks), so the
-- refusal is still recorded as a visible exception.
create function public.ingest_events(p_batch jsonb, p_rejections jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_dev public.devices;
  v_dev_id uuid;
  v_sent timestamptz;
  v_skew boolean;
  v_tolerance int;
  v_roles gc.role[];
  v_batch uuid := gen_random_uuid();
  v_results jsonb := '[]'::jsonb;
  v_result jsonb;
  v_ev jsonb;
  v_msg text;
begin
  perform gc.need(v_uid is not null, 'not signed in');
  select p.org_id into v_org from public.profiles p where p.user_id = v_uid and p.active;
  perform gc.need(v_org is not null, 'no active GC profile for this user');
  perform gc.need(jsonb_typeof(p_batch -> 'events') = 'array', 'batch.events must be an array');
  perform gc.need(jsonb_array_length(p_batch -> 'events') between 1 and 500, 'batch must have 1–500 events');

  if p_batch ? 'deviceId' and p_batch ->> 'deviceId' is not null then
    v_dev_id := (p_batch ->> 'deviceId')::uuid;
    select * into v_dev from public.devices where id = v_dev_id;
    perform gc.need(found, 'device is not registered');
    perform gc.need(v_dev.user_id = v_uid, 'device is registered to another user');
    if v_dev.revoked_at is not null then
      -- Scenario E / D-032: a revoked device's uploads go to quarantine for Accounts, never into the ledger.
      for v_ev in select * from jsonb_array_elements(p_batch -> 'events') loop
        insert into public.quarantined_events (org_id, device_id, user_id, event_id, raw, reason)
        values (v_org, v_dev.id, v_uid, v_ev ->> 'id', v_ev, 'device revoked');
        v_results := v_results || jsonb_build_object('id', v_ev ->> 'id', 'status', 'quarantined',
                                                     'error', 'device revoked: sign in again');
      end loop;
      return jsonb_build_object('batch', 'device_revoked', 'clockSkew', false, 'results', v_results);
    end if;
    update public.devices set last_sync_at = now() where id = v_dev.id;
  end if;

  begin
    v_sent := (p_batch ->> 'sentAt')::timestamptz;
  exception when others then
    v_sent := null;
  end;
  perform gc.need(v_sent is not null, 'batch.sentAt (device clock) is required');
  select s.clock_skew_minutes into v_tolerance from public.org_settings s where s.org_id = v_org;
  v_skew := abs(extract(epoch from (v_sent - now()))) > coalesce(v_tolerance, 10) * 60;
  v_roles := gc.roles_for(v_uid, v_dev_id, gc.session_aal2());

  for v_ev in select * from jsonb_array_elements(p_batch -> 'events') loop
    if p_rejections ? coalesce(v_ev ->> 'id', '') then
      v_msg := p_rejections ->> (v_ev ->> 'id');
      v_result := jsonb_build_object('id', v_ev ->> 'id', 'status', 'rejected', 'error', v_msg);
    else
      begin
        v_result := gc.post_event(v_ev, v_uid, v_org, v_roles, v_dev, v_skew, v_batch);
      exception when others then
        -- Scenario D4: the sub-transaction rolled back, so nothing from this event was posted.
        v_msg := sqlerrm;
        v_result := jsonb_build_object('id', v_ev ->> 'id', 'status', 'rejected', 'error', v_msg);
      end;
    end if;
    if v_result ->> 'status' = 'rejected' then
      perform gc.log_exception(v_org, 'rejected', v_ev ->> 'id',
        case when coalesce(v_ev ->> 'tripId', '') ~* '^[0-9a-f-]{36}$' then (v_ev ->> 'tripId')::uuid end,
        v_uid, v_dev_id, v_msg, v_ev);
    end if;
    v_results := v_results || v_result;
  end loop;

  return jsonb_build_object('batch', 'ok', 'clockSkew', v_skew, 'results', v_results);
end $$;
revoke execute on function public.ingest_events(jsonb, jsonb) from public, anon;
grant execute on function public.ingest_events(jsonb, jsonb) to authenticated;
