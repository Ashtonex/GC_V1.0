/**
 * M2 gate: every row of the Section 4B permission matrix is ENFORCED by the database (RLS + server functions),
 * tested for all four roles. The matrix itself lives in packages/schema/src/permissions.ts; the meta-test at the
 * bottom fails if a row has no enforcement test here.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTIONS, type Action, type TripEvent } from '@gc/schema';
import { TestDb, type Session } from './harness/db.ts';
import { ingest, planTrip, seedWorld, setState, type World } from './harness/fixtures.ts';
import { makeEvents, tripAt } from './harness/builders.ts';

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await TestDb.create();
  w = await seedWorld(db);
});
afterAll(() => db.close());

const status = async (s: Session, events: TripEvent[]) => (await ingest(db, s, events)).results.map((r) => r.status);
const accepted = async (s: Session, e: TripEvent) => expect(await status(s, [e])).toEqual(['accepted']);
const rejected = async (s: Session, e: TripEvent, why?: RegExp) => {
  const [r] = (await ingest(db, s, [e])).results;
  expect(r!.status).toBe('rejected');
  if (why) expect(r!.error).toMatch(why);
};
const rlsDenied = (p: Promise<unknown>) =>
  expect(p).rejects.toThrow(/row-level security|permission denied|only the Owner/);
const noRows = async (p: Promise<unknown[]>) => expect(await p).toEqual([]);
const others = (allowed: (keyof World['s'])[]) =>
  (['owner', 'accounts', 'warehouse', 'driver'] as const).filter((r) => !allowed.includes(r));

const tested = new Set<Action>();
function row(action: Action, label: string, fn: () => Promise<void>) {
  tested.add(action);
  it(`${action} — ${label}`, fn);
}

/** A trip at AWAITING_ACCEPTANCE whose stock issue the driver has accepted, ready for dispatch approval. */
async function readyToDispatch() {
  const { trip, ev } = await tripAt(db, w, 'AWAITING_ACCEPTANCE');
  const [h] = await db.admin<{ id: string }>(`select id from public.handovers where trip_id = $1`, [trip]);
  await accepted(w.s.driver, ev.stockRespond(h!.id));
  return trip;
}

describe('Section 4B permission matrix — enforced on the server, one test per row', () => {
  row('users.manage', 'Owner only: assign roles, create profiles, revoke devices', async () => {
    const uid = randomUUID();
    await db.admin(`insert into auth.users (id) values ($1)`, [uid]);
    for (const r of others(['owner'])) {
      await rlsDenied(
        db.as(w.s[r], `insert into public.profiles (user_id, org_id, display_name) values ($1, $2, 'x')`, [uid, w.org]),
      );
    }
    await db.as(w.s.owner, `insert into public.profiles (user_id, org_id, display_name) values ($1, $2, 'New')`, [
      uid,
      w.org,
    ]);
    for (const r of others(['owner'])) {
      await rlsDenied(
        db.as(w.s[r], `insert into public.user_roles (user_id, role, granted_by) values ($1, 'driver', $2)`, [
          uid,
          w.s[r].userId,
        ]),
      );
    }
    await db.as(w.s.owner, `insert into public.user_roles (user_id, role, granted_by) values ($1, 'driver', $2)`, [
      uid,
      w.user.owner,
    ]);
    const phone = randomUUID();
    await db.as({ userId: uid }, `select public.register_device($1, 'driver_phone')`, [phone]);
    for (const r of others(['owner'])) {
      await expect(db.as(w.s[r], `select public.revoke_device($1, 'test')`, [phone])).rejects.toThrow(/only the Owner/);
    }
    await db.as(w.s.owner, `select public.revoke_device($1, 'test')`, [phone]);
  });

  row('products.manage', 'Owner, Accounts write; Warehouse view; Driver view own trip only', async () => {
    for (const r of ['owner', 'accounts'] as const) {
      await db.as(
        w.s[r],
        `insert into public.products (org_id, sku, name, base_unit, pack_size) values ($1, $2, 'x', 'case', 1)`,
        [w.org, `SKU-${r}`],
      );
    }
    for (const r of others(['owner', 'accounts'])) {
      await rlsDenied(
        db.as(
          w.s[r],
          `insert into public.products (org_id, sku, name, base_unit, pack_size) values ($1, 'NOPE', 'x', 'case', 1)`,
          [w.org],
        ),
      );
      await noRows(db.as(w.s[r], `update public.products set name = 'hacked' returning id`));
    }
    expect((await db.as(w.s.warehouse, `select id from public.products`)).length).toBeGreaterThanOrEqual(5);
    // Driver: only products on the price list of their in-progress trip.
    await tripAt(db, w, 'DISPATCHED');
    const seen = await db.as<{ sku: string }>(w.s.driver, `select sku from public.products order by sku`);
    expect(seen.map((r) => r.sku)).toEqual(['P1', 'P2', 'P3']);
    await noRows(db.as(w.s.driver2, `select id from public.products`)); // no trip in progress
  });

  row('prices.set', 'Owner only; Accounts read; Driver reads cached list of own trip; Warehouse nothing', async () => {
    const p1 = w.ids.of('P1');
    expect(
      await db.as(
        w.s.owner,
        `update public.price_list_items set unit_price_minor = 3600 where product_id = $1 returning 1 as ok`,
        [p1],
      ),
    ).toEqual([{ ok: 1 }]);
    for (const r of others(['owner'])) {
      await noRows(db.as(w.s[r], `update public.price_list_items set unit_price_minor = 1 returning 1`));
      await rlsDenied(db.as(w.s[r], `insert into public.price_lists (org_id, name) values ($1, 'x')`, [w.org]));
    }
    expect((await db.as(w.s.accounts, `select * from public.price_list_items`)).length).toBe(3);
    await noRows(db.as(w.s.warehouse, `select * from public.price_list_items`));
    await tripAt(db, w, 'DISPATCHED');
    expect((await db.as(w.s.driver, `select * from public.price_list_items`)).length).toBe(3);
  });

  row('costs.set', 'Owner, Accounts; Driver NEVER sees a cost (rule 5); Warehouse nothing', async () => {
    for (const r of ['owner', 'accounts'] as const) {
      await db.as(
        w.s[r],
        `insert into public.product_costs (org_id, product_id, unit_cost_minor, currency, effective_from, entered_by)
        values ($1, $2, 1500, 'USD', now() + interval '1 year' + $3::interval, $4)`,
        [w.org, w.ids.of('P3'), r === 'owner' ? '1 day' : '2 days', w.s[r].userId],
      );
    }
    for (const r of others(['owner', 'accounts'])) {
      await rlsDenied(
        db.as(
          w.s[r],
          `insert into public.product_costs (org_id, product_id, unit_cost_minor, currency, effective_from, entered_by)
        values ($1, $2, 1, 'USD', now(), $3)`,
          [w.org, w.ids.of('P3'), w.s[r].userId],
        ),
      );
      await noRows(db.as(w.s[r], `select * from public.product_costs`));
    }
    // A driver with a sale on their trip still sees no cost anywhere.
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    await accepted(w.s.driver, ev.sale());
    await noRows(db.as(w.s.driver, `select * from public.sale_line_costs`));
    const payloads = await db.as<{ p: string }>(w.s.driver, `select payload::text as p from public.trip_events`);
    expect(payloads.length).toBeGreaterThan(0);
    for (const { p } of payloads) expect(p).not.toMatch(/cost/i);
  });

  row('fx.enter', 'Owner, Accounts enter; Driver views; Warehouse nothing', async () => {
    for (const r of ['owner', 'accounts'] as const) {
      await db.as(
        w.s[r],
        `insert into public.exchange_rates (org_id, from_ccy, to_ccy, rate_decimal, source, effective_at, entered_by)
        values ($1, 'USD', 'ZWG', '27.00', 'TEST', now(), $2)`,
        [w.org, w.s[r].userId],
      );
    }
    for (const r of others(['owner', 'accounts'])) {
      await rlsDenied(
        db.as(
          w.s[r],
          `insert into public.exchange_rates (org_id, from_ccy, to_ccy, rate_decimal, source, effective_at, entered_by)
        values ($1, 'USD', 'ZWG', '1.00', 'X', now(), $2)`,
          [w.org, w.s[r].userId],
        ),
      );
    }
    expect((await db.as(w.s.driver, `select * from public.exchange_rates`)).length).toBeGreaterThan(0);
    await noRows(db.as(w.s.warehouse, `select * from public.exchange_rates`));
  });

  row('credit_limits.set', 'Owner only', async () => {
    const b = w.ids.of('cust-B');
    expect(
      await db.as(w.s.owner, `update public.customers set credit_limit_minor = 10000 where id = $1 returning 1 as ok`, [
        b,
      ]),
    ).toEqual([{ ok: 1 }]);
    await expect(
      db.as(w.s.accounts, `update public.customers set credit_limit_minor = 99999 where id = $1`, [b]),
    ).rejects.toThrow(/only the Owner sets customer credit limits/);
    await expect(
      db.as(
        w.s.accounts,
        `insert into public.customers (id, org_id, name, credit_limit_minor) values ($1, $2, 'x', 5)`,
        [randomUUID(), w.org],
      ),
    ).rejects.toThrow(/only the Owner/);
    for (const r of ['warehouse', 'driver'] as const) {
      await noRows(
        db.as(w.s[r], `update public.customers set credit_limit_minor = 99999 where id = $1 returning 1`, [b]),
      );
    }
  });

  row('customers.create', 'Owner, Accounts; Driver only during a sale on own DISPATCHED trip', async () => {
    for (const r of ['owner', 'accounts'] as const) {
      await db.as(w.s[r], `insert into public.customers (id, org_id, name) values ($1, $2, 'Office customer')`, [
        randomUUID(),
        w.org,
      ]);
    }
    for (const r of ['warehouse', 'driver'] as const) {
      await rlsDenied(
        db.as(w.s[r], `insert into public.customers (id, org_id, name) values ($1, $2, 'x')`, [randomUUID(), w.org]),
      );
    }
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    await accepted(w.s.driver, ev.customer('+263 71 000 0001'));
    await rejected(w.s.driver2, ev.customer('+263 71 000 0002', w.user.driver2), /only the trip driver/);
    await rejected(w.s.accounts, ev.customer('+263 71 000 0003', w.user.accounts), /only the trip driver/);
    const { ev: early } = await tripAt(db, w, 'AWAITING_ACCEPTANCE');
    await rejected(w.s.driver, early.customer('+263 71 000 0004'), /DISPATCHED/);
  });

  row('customers.edit_merge', 'Owner, Accounts only', async () => {
    const [a, d] = [w.ids.of('cust-A'), w.ids.of('cust-D')];
    for (const r of ['owner', 'accounts'] as const) {
      expect(
        await db.as(w.s[r], `update public.customers set name = name where id = $1 returning 1 as ok`, [a]),
      ).toEqual([{ ok: 1 }]);
    }
    for (const r of ['warehouse', 'driver'] as const) {
      await noRows(db.as(w.s[r], `update public.customers set merged_into_id = $1 where id = $2 returning 1`, [a, d]));
    }
  });

  row('trips.plan', 'Owner, Accounts only', async () => {
    for (const r of ['owner', 'accounts'] as const) {
      await db.as(
        w.s[r],
        `insert into public.trips (org_id, truck_id, driver_id, price_list_id, planned_date, created_by)
        values ($1, $2, $3, $4, current_date, $5)`,
        [w.org, w.truck2, w.user.driver, w.priceList, w.s[r].userId],
      );
    }
    for (const r of ['warehouse', 'driver'] as const) {
      await rlsDenied(
        db.as(
          w.s[r],
          `insert into public.trips (org_id, truck_id, driver_id, price_list_id, planned_date, created_by)
        values ($1, $2, $3, $4, current_date, $5)`,
          [w.org, w.truck2, w.user.driver, w.priceList, w.s[r].userId],
        ),
      );
    }
    // Nobody updates a trip directly (state changes go through set_trip_state).
    for (const r of ['owner', 'accounts', 'warehouse', 'driver'] as const) {
      await noRows(db.as(w.s[r], `update public.trips set state = 'CLOSED' returning id`));
    }
  });

  row('stock.issue', 'Warehouse only, while LOADING', async () => {
    const { ev } = await tripAt(db, w, 'LOADING');
    await accepted(w.s.warehouse, ev.stockIssue({ P2: 5 }));
    for (const r of others(['warehouse'])) {
      await rejected(w.s[r], ev.stockIssue({ P2: 5 }, w.s[r].userId), /only Warehouse/);
    }
  });

  row('cash.issue', 'Owner, Accounts only', async () => {
    const { ev } = await tripAt(db, w, 'LOADING');
    for (const r of ['owner', 'accounts'] as const) await accepted(w.s[r], ev.cashIssue(50, w.s[r].userId));
    for (const r of others(['owner', 'accounts'])) {
      await rejected(w.s[r], ev.cashIssue(50, w.s[r].userId), /only Owner or Accounts issues cash/);
    }
  });

  row('handovers.respond_departure', 'Driver of the trip only, while AWAITING_ACCEPTANCE', async () => {
    const { trip, ev } = await tripAt(db, w, 'LOADING');
    const cash = ev.cashIssue(100) as Extract<TripEvent, { type: 'CASH_HANDOVER_ISSUED' }>;
    await accepted(w.s.accounts, cash);
    await setState(db, w.s.warehouse, trip, 'AWAITING_ACCEPTANCE');
    for (const r of ['owner', 'warehouse'] as const) {
      await rejected(w.s[r], ev.cashRespond(cash.handoverId, 100, w.s[r].userId), /only the trip driver/);
    }
    await rejected(
      w.s.accounts,
      ev.cashRespond(cash.handoverId, 100, w.user.accounts),
      /self-acceptance|only the trip driver/,
    );
    await rejected(w.s.driver2, ev.cashRespond(cash.handoverId, 100, w.user.driver2), /only the trip driver/);
    await accepted(w.s.driver, ev.cashRespond(cash.handoverId, 100));
  });

  row('dispatch.approve', 'Owner, Accounts only', async () => {
    for (const r of ['owner', 'accounts'] as const) {
      const trip = await readyToDispatch();
      await setState(db, w.s[r], trip, 'DISPATCHED');
      const [t] = await db.admin<{ state: string; business_date: unknown }>(
        `select state, business_date from public.trips where id = $1`,
        [trip],
      );
      expect(t!.state).toBe('DISPATCHED');
      expect(t!.business_date).not.toBeNull();
    }
    const trip = await readyToDispatch();
    for (const r of others(['owner', 'accounts'])) {
      await expect(setState(db, w.s[r], trip, 'DISPATCHED')).rejects.toThrow(
        /only Owner or Accounts approves dispatch/,
      );
    }
  });

  row('sales.record', 'Driver only, own DISPATCHED trip, from the registered phone', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    await accepted(w.s.driver, ev.sale());
    for (const r of others(['driver']))
      await rejected(w.s[r], ev.sale({ actor: w.s[r].userId }), /only the trip driver/);
    await rejected(w.s.driver2, ev.sale({ actor: w.user.driver2 }), /only the trip driver/);
    await rejected({ userId: w.user.driver }, ev.sale(), /driver phone/); // no device
    await rejected(w.s.driver, ev.collection(5, w.user.driver2), /actorId must be the signed-in user/);
    const { ev: notYet } = await tripAt(db, w, 'AWAITING_ACCEPTANCE');
    await rejected(w.s.driver, notYet.sale(), /DISPATCHED/);
  });

  row('discount.override', 'Owner sets the limit; Driver only within it; off by default', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    await rejected(w.s.driver, ev.sale({ qty: 10, discount: 10 }), /switched off/);
    for (const r of others(['owner'])) {
      await noRows(db.as(w.s[r], `update public.org_settings set driver_discount_max_pct = 50 returning 1`));
    }
    expect(
      await db.as(w.s.owner, `update public.org_settings set driver_discount_max_pct = 5 returning 1 as ok`),
    ).toEqual([{ ok: 1 }]);
    await accepted(w.s.driver, ev.sale({ qty: 10, discount: 18 })); // 18 / 360 = 5%
    await rejected(w.s.driver, ev.sale({ qty: 10, discount: 19 }), /above the Owner-set limit/);
    await db.admin(`update public.org_settings set driver_discount_max_pct = null`);
  });

  row(
    'sales.credit',
    'Driver within the customer limit; over the limit is flagged for Accounts, never dropped',
    async () => {
      const { trip, ev } = await tripAt(db, w, 'DISPATCHED');
      const within = ev.sale({ qty: 2, customer: w.ids.of('cust-B'), credit: 48 });
      await accepted(w.s.driver, within);
      const over = ev.sale({ qty: 2, customer: w.ids.of('cust-B'), credit: 60 }); // 48 + 60 > 100.00 limit
      await accepted(w.s.driver, over);
      const ex = await db.as<{ event_id: string; kind: string }>(
        w.s.accounts,
        `select event_id, kind from public.ingest_exceptions where trip_id = $1 and kind = 'credit_over_limit'`,
        [trip],
      );
      expect(ex).toEqual([{ event_id: over.id, kind: 'credit_over_limit' }]);
      for (const r of others(['driver'])) {
        await rejected(
          w.s[r],
          ev.sale({ actor: w.s[r].userId, customer: w.ids.of('cust-B'), credit: 10 }),
          /only the trip driver/,
        );
      }
    },
  );

  row('expenses.report', 'Driver (office-paid expenses by Owner/Accounts, D-050 interim)', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    await accepted(w.s.driver, ev.expense(6));
    for (const r of ['owner', 'accounts'] as const) {
      await rejected(w.s[r], ev.expense(6, w.s[r].userId, 'driver_cash'), /only the trip driver reports/);
    }
    await rejected(w.s.warehouse, ev.expense(6, w.user.warehouse, 'office'), /only the trip driver reports/);
  });

  row('expenses.review', 'Owner any amount; Accounts up to the Owner-set limit; never Warehouse/Driver', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    const small = ev.expense(50) as Extract<TripEvent, { type: 'EXPENSE_REPORTED' }>;
    const big = ev.expense(500) as Extract<TripEvent, { type: 'EXPENSE_REPORTED' }>;
    await accepted(w.s.driver, small);
    await accepted(w.s.driver, big);
    for (const r of ['warehouse', 'driver'] as const) {
      await rejected(
        w.s[r],
        ev.review(small.expenseId, w.s[r].userId),
        /only Owner or Accounts|cannot review an expense you reported/,
      );
    }
    await rejected(w.s.accounts, ev.review(big.expenseId, w.user.accounts), /needs the Owner/);
    await accepted(w.s.accounts, ev.review(big.expenseId, w.user.accounts, 'evidence_reviewed'));
    await accepted(w.s.accounts, ev.review(small.expenseId, w.user.accounts));
    await accepted(w.s.owner, ev.review(big.expenseId, w.user.owner));
  });

  row('payments.verify', 'Owner, Accounts only', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    const s1 = ev.sale({ tender: 'ecocash' }) as Extract<TripEvent, { type: 'SALE_RECORDED' }>;
    const s2 = ev.sale({ tender: 'swipe' }) as Extract<TripEvent, { type: 'SALE_RECORDED' }>;
    await accepted(w.s.driver, s1);
    await accepted(w.s.driver, s2);
    for (const r of ['warehouse', 'driver'] as const) {
      await rejected(w.s[r], ev.verify(s1.payments[0]!.paymentId, w.s[r].userId), /only Owner or Accounts verifies/);
    }
    await accepted(w.s.owner, ev.verify(s1.payments[0]!.paymentId, w.user.owner));
    await accepted(w.s.accounts, ev.verify(s2.payments[0]!.paymentId, w.user.accounts));
    await rejected(w.s.accounts, ev.verify(s2.payments[0]!.paymentId, w.user.accounts), /already verified/);
  });

  row('returns.count', 'Warehouse and Driver, both sides required; not Owner/Accounts', async () => {
    const { ev } = await tripAt(db, w, 'RETURNED');
    const back = ev.stockIssue({ P1: 20 }, w.user.driver, 'from_truck') as Extract<
      TripEvent,
      { type: 'STOCK_HANDOVER_ISSUED' }
    >;
    await accepted(w.s.driver, back);
    await rejected(w.s.driver, ev.stockRespond(back.handoverId, { P1: 20 }, w.user.driver), /self-acceptance/);
    for (const r of ['owner', 'accounts'] as const) {
      await rejected(
        w.s[r],
        ev.stockRespond(back.handoverId, { P1: 20 }, w.s[r].userId),
        /only Warehouse or the trip driver/,
      );
      await rejected(
        w.s[r],
        ev.stockIssue({ P1: 1 }, w.s[r].userId, 'from_truck'),
        /only Warehouse or the trip driver/,
      );
    }
    await accepted(w.s.warehouse, ev.stockRespond(back.handoverId, { P1: 20 }, w.user.warehouse));
    const [h] = await db.admin<{ status: string }>(`select status from public.handovers where id = $1`, [
      back.handoverId,
    ]);
    expect(h!.status).toBe('accepted');
  });

  row('cash_handover.receive', 'Owner, Accounts receive; the driver hands over', async () => {
    for (const r of ['owner', 'accounts'] as const) {
      const { ev } = await tripAt(db, w, 'RETURNED');
      const back = ev.cashIssue(100, w.user.driver, 'from_truck') as Extract<
        TripEvent,
        { type: 'CASH_HANDOVER_ISSUED' }
      >;
      await accepted(w.s.driver, back);
      await rejected(
        w.s.warehouse,
        ev.cashRespond(back.handoverId, 100, w.user.warehouse),
        /only Owner or Accounts receives/,
      );
      await rejected(w.s.driver, ev.cashRespond(back.handoverId, 100, w.user.driver), /self-acceptance/);
      await accepted(w.s[r], ev.cashRespond(back.handoverId, 100, w.s[r].userId));
    }
    const { ev } = await tripAt(db, w, 'RETURNED');
    await rejected(w.s.accounts, ev.cashIssue(100, w.user.accounts, 'from_truck'), /only the trip driver hands over/);
  });

  row(
    'corrections.record',
    'Owner; Accounts with reason; Warehouse own stock events; Driver requests a correction',
    async () => {
      const { ev } = await tripAt(db, w, 'DISPATCHED');
      const [a, b, c] = [ev.sale(), ev.sale(), ev.damage()];
      for (const e of [a, b, c]) await accepted(w.s.driver, e);
      await accepted(w.s.owner, ev.reverse(a.id, w.user.owner));
      await accepted(w.s.accounts, ev.reverse(b.id, w.user.accounts));
      await rejected(w.s.driver, ev.reverse(c.id, w.user.driver), /request a correction/);
      await rejected(w.s.warehouse, ev.reverse(c.id, w.user.warehouse), /not allowed/); // not the warehouse's own event
      const { trip: t2, ev: ev2 } = await tripAt(db, w, 'LOADING');
      const own = ev2.stockIssue({ P3: 1 });
      await accepted(w.s.warehouse, own);
      await accepted(w.s.warehouse, ev2.reverse(own.id, w.user.warehouse));
      const noReason = { ...ev2.reverse(own.id, w.user.owner), reason: '' };
      await rejected(w.s.owner, noReason as TripEvent);
      void t2;
    },
  );

  row('loss.confirm', 'Owner only (two-factor session)', async () => {
    const { ev } = await tripAt(db, w, 'RECONCILING');
    for (const r of others(['owner'])) await rejected(w.s[r], ev.loss(w.s[r].userId), /only the Owner confirms a loss/);
    await rejected({ userId: w.user.owner, aal: 'aal1' }, ev.loss(), /only the Owner/);
    await accepted(w.s.owner, ev.loss());
  });

  row('trips.close', 'Owner, Accounts; only via the close-trip function (service role)', async () => {
    for (const r of ['owner', 'accounts'] as const) {
      const { trip } = await tripAt(db, w, 'RECONCILING');
      const [t] = await db.service<{ state: string }>(
        `select (public.close_trip($1, $2, true, null, 'CLOSED', '[]'::jsonb)).state`,
        [trip, w.user[r]],
      );
      expect(t!.state).toBe('CLOSED');
    }
    const { trip } = await tripAt(db, w, 'RECONCILING');
    for (const r of others(['owner', 'accounts'])) {
      await expect(
        db.service(`select public.close_trip($1, $2, true, $3, 'CLOSED', '[]'::jsonb)`, [
          trip,
          w.user[r],
          w.s[r].deviceId ?? null,
        ]),
      ).rejects.toThrow(/only Owner or Accounts closes/);
    }
    // No signed-in user may call close_trip directly (it would skip the engine's close check).
    await expect(
      db.as(w.s.owner, `select public.close_trip($1, $2, true, null, 'CLOSED', '[]'::jsonb)`, [trip, w.user.owner]),
    ).rejects.toThrow(/permission denied/);
  });

  row('trips.close_with_exceptions', 'Owner only; every open item gets an owner and a due date', async () => {
    const { trip } = await tripAt(db, w, 'RECONCILING');
    const items = JSON.stringify([{ ref: 'cash-return:USD', kind: 'cash_difference', detail: 'USD 20.00 short' }]);
    await expect(
      db.service(`select public.close_trip($1, $2, true, null, 'CLOSED_WITH_EXCEPTIONS', $3::jsonb, '[]')`, [
        trip,
        w.user.accounts,
        items,
      ]),
    ).rejects.toThrow(/only the Owner closes a trip with exceptions/);
    await expect(
      db.service(`select public.close_trip($1, $2, true, null, 'CLOSED_WITH_EXCEPTIONS', $3::jsonb, '[]')`, [
        trip,
        w.user.owner,
        items,
      ]),
    ).rejects.toThrow(/has no owner and due date/);
    await expect(
      db.service(`select public.close_trip($1, $2, true, null, 'CLOSED', $3::jsonb)`, [trip, w.user.owner, items]),
    ).rejects.toThrow(/only be closed with exceptions/);
    const assign = JSON.stringify([{ itemRef: 'cash-return:USD', assignedTo: w.user.accounts, dueDate: '2026-11-30' }]);
    await db.service(`select public.close_trip($1, $2, true, null, 'CLOSED_WITH_EXCEPTIONS', $3::jsonb, $4::jsonb)`, [
      trip,
      w.user.owner,
      items,
      assign,
    ]);
    const rows = await db.as(
      w.s.accounts,
      `select item_ref, assigned_to from public.trip_close_exceptions where trip_id = $1`,
      [trip],
    );
    expect(rows).toEqual([{ item_ref: 'cash-return:USD', assigned_to: w.user.accounts }]);
  });

  row('location.view', 'Owner, Accounts; Driver own pings only; Warehouse nothing', async () => {
    const { trip } = await tripAt(db, w, 'DISPATCHED');
    const ping = (user: string, dev: string) =>
      db.admin(
        `insert into public.location_pings (id, org_id, trip_id, user_id, device_id, lat, lng, source, occurred_at)
       values ($1, $2, $3, $4, $5, -18.97, 32.67, 'watch', now())`,
        [randomUUID(), w.org, trip, user, dev],
      );
    await ping(w.user.driver, w.devices.driver);
    await ping(w.user.driver2, w.devices.driver2);
    for (const r of ['owner', 'accounts'] as const) {
      expect((await db.as(w.s[r], `select id from public.location_pings where trip_id = $1`, [trip])).length).toBe(2);
    }
    expect(
      (await db.as<{ user_id: string }>(w.s.driver, `select user_id from public.location_pings`)).every(
        (p) => p.user_id === w.user.driver,
      ),
    ).toBe(true);
    await noRows(db.as(w.s.warehouse, `select id from public.location_pings`));
  });

  row(
    'close_report.view',
    'Owner, Accounts: margin data (cost snapshots) readable; Warehouse/Driver never',
    async () => {
      const { ev } = await tripAt(db, w, 'DISPATCHED');
      await accepted(w.s.driver, ev.sale());
      for (const r of ['owner', 'accounts'] as const) {
        expect((await db.as(w.s[r], `select * from public.sale_line_costs`)).length).toBeGreaterThan(0);
      }
      for (const r of ['warehouse', 'driver'] as const) {
        await noRows(db.as(w.s[r], `select * from public.sale_line_costs`));
        await noRows(db.as(w.s[r], `select * from public.product_costs`));
      }
    },
  );

  row(
    'own_trip_summary.view',
    'Driver sees own trip sales, cash, stock; not other trips; Warehouse no sales',
    async () => {
      const { trip, ev } = await tripAt(db, w, 'DISPATCHED');
      await accepted(w.s.driver, ev.sale());
      const mine = await db.as<{ trip_id: string }>(w.s.driver, `select distinct trip_id from public.sales`);
      expect(mine.map((r) => r.trip_id)).toContain(trip);
      expect((await db.as(w.s.driver, `select * from public.handovers where trip_id = $1`, [trip])).length).toBe(1);
      await noRows(db.as(w.s.driver2, `select * from public.sales`));
      await noRows(db.as(w.s.warehouse, `select * from public.sales`));
      await noRows(db.as(w.s.warehouse, `select * from public.payments`));
    },
  );

  row(
    'audit_log.view',
    'Owner, Accounts see every event; Driver only own in-progress trip; Warehouse stock only',
    async () => {
      const { trip, ev } = await tripAt(db, w, 'DISPATCHED');
      await accepted(w.s.driver, ev.sale());
      const all = await db.admin<{ n: number }>(`select count(*)::int as n from public.trip_events`);
      for (const r of ['owner', 'accounts'] as const) {
        expect((await db.as<{ n: number }>(w.s[r], `select count(*)::int as n from public.trip_events`))[0]!.n).toBe(
          all[0]!.n,
        );
      }
      const driverTrips = await db.as<{ trip_id: string }>(
        w.s.driver,
        `select distinct trip_id from public.trip_events`,
      );
      const inProgress = await db.admin<{ id: string }>(
        `select id from public.trips where driver_id = $1
      and state in ('LOADING','AWAITING_ACCEPTANCE','DISPATCHED','RETURNED','RECONCILING')`,
        [w.user.driver],
      );
      expect(new Set(driverTrips.map((r) => r.trip_id))).toEqual(new Set(inProgress.map((r) => r.id)));
      await noRows(db.as(w.s.driver2, `select * from public.trip_events where trip_id = $1`, [trip]));
      const wh = await db.as<{ type: string }>(w.s.warehouse, `select distinct type from public.trip_events`);
      expect(wh.every((r) => r.type.startsWith('STOCK_'))).toBe(true);
      await noRows(db.as(w.s.warehouse, `select * from public.ingest_exceptions`));
      await noRows(db.as(w.s.driver, `select * from public.ingest_exceptions`));
    },
  );

  it('every action in permissions.ts has an enforcement test above', () => {
    expect([...tested].sort()).toEqual([...ACTIONS].sort());
  });
});

describe('separation of duties (Section 4B rules 1–6)', () => {
  it('rule 1 — no self-acceptance: issuer and receiver must be different people', async () => {
    const { ev } = await tripAt(db, w, 'RETURNED');
    const back = ev.stockIssue({ P1: 20 }, w.user.warehouse, 'from_truck') as Extract<
      TripEvent,
      { type: 'STOCK_HANDOVER_ISSUED' }
    >;
    await accepted(w.s.warehouse, back);
    await rejected(w.s.warehouse, ev.stockRespond(back.handoverId, { P1: 20 }, w.user.warehouse), /self-acceptance/);
    await accepted(w.s.driver, ev.stockRespond(back.handoverId, { P1: 20 }, w.user.driver));
  });

  it('rule 2 — no self-approval per item; recording OTHER events on the trip does not block', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    const allowance = ev.expense(20, w.user.accounts, 'office') as Extract<TripEvent, { type: 'EXPENSE_REPORTED' }>;
    const fuel = ev.expense(50) as Extract<TripEvent, { type: 'EXPENSE_REPORTED' }>;
    await accepted(w.s.accounts, allowance);
    await accepted(w.s.driver, fuel);
    await rejected(
      w.s.accounts,
      ev.review(allowance.expenseId, w.user.accounts),
      /cannot review an expense you reported/,
    );
    await accepted(w.s.accounts, ev.review(fuel.expenseId, w.user.accounts)); // A1 recorded other items: still fine
    // Only one Accounts person available → the Owner signs it off ("Needs Owner"), so nothing deadlocks.
    await accepted(w.s.owner, ev.review(allowance.expenseId, w.user.owner));
  });

  it('rule 2 — a person holding Driver + Accounts cannot verify a payment they recorded', async () => {
    const phone = w.devices.mixedPhone;
    const s = { userId: w.user.mixed, deviceId: phone };
    const { ev } = await tripAt(db, w, 'DISPATCHED', { id: w.user.mixed, s });
    const sale = ev.sale({ actor: w.user.mixed, tender: 'ecocash' }) as Extract<TripEvent, { type: 'SALE_RECORDED' }>;
    await accepted(s, sale);
    await rejected(
      { userId: w.user.mixed },
      ev.verify(sale.payments[0]!.paymentId, w.user.mixed),
      /you cannot verify a payment you recorded/,
    );
    await accepted(w.s.accounts2, ev.verify(sale.payments[0]!.paymentId, w.user.accounts2));
  });

  it('rule 3 — closing verifies nothing: CLOSED is refused while a payment is unverified, whatever the caller claims', async () => {
    const { trip, ev } = await tripAt(db, w, 'DISPATCHED');
    await accepted(w.s.driver, ev.sale({ tender: 'swipe' }));
    await setState(db, w.s.driver, trip, 'RETURNED');
    await setState(db, w.s.accounts, trip, 'RECONCILING');
    await expect(
      db.service(`select public.close_trip($1, $2, true, null, 'CLOSED', '[]'::jsonb)`, [trip, w.user.accounts]),
    ).rejects.toThrow(/payments are not verified/);
  });

  it("rule 4 — Owner actions are logged like everyone else's", async () => {
    const trip = await planTrip(db, w, { truck: await tripTruck() });
    await setState(db, w.s.owner, trip, 'LOADING');
    const [e] = await db.admin<{ actor_id: string; type: string }>(
      `select actor_id, type from public.trip_events where trip_id = $1`,
      [trip],
    );
    expect(e).toEqual({ actor_id: w.user.owner, type: 'TRIP_STATUS_CHANGED' });
  });

  it('D-027 — on a driver phone, a Driver + Accounts person gets driver powers only', async () => {
    const onPhone = { userId: w.user.mixed, deviceId: w.devices.mixedPhone };
    await noRows(db.as(onPhone, `select * from public.product_costs`));
    await rlsDenied(
      db.as(
        onPhone,
        `insert into public.exchange_rates (org_id, from_ccy, to_ccy, rate_decimal, source, effective_at, entered_by)
      values ($1, 'USD', 'ZWG', '27.00', 'X', now(), $2)`,
        [w.org, w.user.mixed],
      ),
    );
    // Off the phone (office sign-in), the same person has Accounts powers.
    expect((await db.as({ userId: w.user.mixed }, `select * from public.product_costs`)).length).toBeGreaterThan(0);
  });

  it('Owner powers need a two-factor (aal2) session (Section 4)', async () => {
    const aal1 = { userId: w.user.owner, aal: 'aal1' as const };
    await noRows(db.as(aal1, `update public.price_list_items set unit_price_minor = 1 returning 1`));
    await noRows(db.as(aal1, `select * from public.product_costs`));
    await expect(db.as(aal1, `select public.revoke_device($1, 'x')`, [w.devices.driver2])).rejects.toThrow(
      /only the Owner/,
    );
  });

  it('signed-out (anon) callers can read and write nothing', async () => {
    await expect(db.anon(`select * from public.trips`)).rejects.toThrow(/permission denied/);
    await expect(db.anon(`select public.ingest_events('{}'::jsonb)`)).rejects.toThrow(/permission denied/);
  });
});

async function tripTruck(): Promise<string> {
  const truck = randomUUID();
  await db.admin(`insert into public.trucks (id, org_id, registration) values ($1, $2, $3)`, [truck, w.org, truck]);
  return truck;
}

void makeEvents;
