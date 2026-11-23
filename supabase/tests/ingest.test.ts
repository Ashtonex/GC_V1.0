/**
 * Ingestion at the API level (M2 gate): idempotency (Section 2 #8), D3 conflicting resubmission,
 * D4 partial failure, revoked-device quarantine (Scenario E, server side), clock skew (D-024), server-written
 * cost snapshots (Section 2 #7), append-only ledger (Section 2 #2), duplicate customers (Scenario D5).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TripEvent } from '@gc/schema';
import { TestDb } from './harness/db.ts';
import { ingest, seedWorld, type World } from './harness/fixtures.ts';
import { tripAt } from './harness/builders.ts';

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await TestDb.create();
  w = await seedWorld(db);
});
afterAll(() => db.close());

const count = async (table: string, where: string, params: unknown[]) =>
  Number(
    (await db.admin<{ n: string }>(`select count(*)::int as n from public.${table} where ${where}`, params))[0]!.n,
  );

describe('idempotency (Section 2 #8)', () => {
  it('the same batch sent 5 times creates exactly one of each record', async () => {
    const { trip, ev } = await tripAt(db, w, 'DISPATCHED');
    const batch = [ev.sale({ qty: 2 }), ev.sale({ qty: 1 }), ev.collection(5), ev.expense(6)];
    const first = await ingest(db, w.s.driver, batch);
    expect(first.results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    for (let i = 0; i < 4; i++) {
      const again = await ingest(db, w.s.driver, batch);
      expect(again.results.map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
    }
    expect(await count('sales', 'trip_id = $1', [trip])).toBe(2);
    expect(await count('payments', 'trip_id = $1 and collection_id is not null', [trip])).toBe(1);
    expect(await count('expenses', 'trip_id = $1', [trip])).toBe(1);
    expect(await count('trip_events', "trip_id = $1 and type <> 'TRIP_STATUS_CHANGED'", [trip])).toBe(6); // + 2 setup
  });

  it('D2 lost acknowledgement: a retry after the server committed is a duplicate, not a second sale', async () => {
    const { trip, ev } = await tripAt(db, w, 'DISPATCHED');
    const sale = ev.sale();
    await ingest(db, w.s.driver, [sale]); // committed; pretend the reply was lost
    const retry = await ingest(db, w.s.driver, [sale]);
    expect(retry.results[0]).toMatchObject({ id: sale.id, status: 'duplicate' });
    expect(await count('sales', 'trip_id = $1', [trip])).toBe(1);
  });

  it('key order in the JSON does not matter', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    const sale = ev.sale();
    await ingest(db, w.s.driver, [sale]);
    const reordered = Object.fromEntries(Object.entries(sale).reverse());
    expect((await ingest(db, w.s.driver, [reordered])).results[0]!.status).toBe('duplicate');
  });
});

describe('D3 — conflicting resubmission', () => {
  it('keeps the first version, rejects the second and raises a visible exception for Accounts', async () => {
    const { trip, ev } = await tripAt(db, w, 'DISPATCHED');
    const sale = ev.sale({ qty: 2 }) as Extract<TripEvent, { type: 'SALE_RECORDED' }>;
    await ingest(db, w.s.driver, [sale]);
    const changed = {
      ...sale,
      lines: [{ ...sale.lines[0]!, qty: 3 }],
      payments: [{ ...sale.payments[0]!, amount: { currency: 'USD', minor: 10800 } }],
    };
    const out = await ingest(db, w.s.driver, [changed]);
    expect(out.results[0]).toMatchObject({ id: sale.id, status: 'conflict' });
    expect(out.results[0]!.error).toMatch(/Conflicting resubmission/);
    const [line] = await db.admin<{ qty_base_units: number }>(
      `select qty_base_units from public.sale_lines where sale_id = $1`,
      [sale.id],
    );
    expect(line!.qty_base_units).toBe(2);
    const exceptions = await db.as<{ kind: string; event_id: string }>(
      w.s.accounts,
      `select kind, event_id from public.ingest_exceptions where trip_id = $1`,
      [trip],
    );
    expect(exceptions).toContainEqual({ kind: 'conflicting_resubmission', event_id: sale.id });
  });
});

describe('D4 — partial failure', () => {
  it('an invalid payment line posts nothing from that sale and marks it rejected (Needs attention)', async () => {
    const { trip, ev } = await tripAt(db, w, 'DISPATCHED');
    const good = ev.sale();
    const bad = ev.sale({
      payments: [
        { paymentId: randomUUID(), tender: 'cash', amount: { currency: 'USD', minor: 3000 } },
        { paymentId: randomUUID(), tender: 'cash', amount: { currency: 'USD', minor: -100 } }, // invalid line
      ],
    });
    const out = await ingest(db, w.s.driver, [good, bad]);
    expect(out.results.map((r) => r.status)).toEqual(['accepted', 'rejected']);
    expect(await count('trip_events', 'id = $1', [bad.id])).toBe(0);
    expect(await count('sales', 'id = $1', [bad.id])).toBe(0);
    expect(await count('payments', 'event_id = $1', [bad.id])).toBe(0);
    expect(await count('sale_line_costs', 'event_id = $1', [bad.id])).toBe(0);
    expect(await count('sales', 'trip_id = $1', [trip])).toBe(1);
    const ex = await db.as<{ kind: string }>(
      w.s.accounts,
      `select kind from public.ingest_exceptions where event_id = $1`,
      [bad.id],
    );
    expect(ex).toEqual([{ kind: 'rejected' }]);
  });

  it('payments that do not add up to the sale total are rejected', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    const sale = ev.sale({
      payments: [{ paymentId: randomUUID(), tender: 'cash', amount: { currency: 'USD', minor: 3000 } }],
    });
    const out = await ingest(db, w.s.driver, [sale]);
    expect(out.results[0]).toMatchObject({ status: 'rejected' });
    expect(out.results[0]!.error).toMatch(/do not add up/);
  });

  it('events refused by the Edge Function are recorded as rejected exceptions too', async () => {
    const { trip } = await tripAt(db, w, 'DISPATCHED');
    const id = randomUUID();
    const out = await ingest(db, w.s.driver, [{ id, tripId: trip, type: 'SALE_RECORDED' }], {
      rejections: { [id]: 'invalid event: lines Required' },
    });
    expect(out.results[0]).toMatchObject({ id, status: 'rejected', error: 'invalid event: lines Required' });
    expect(await count('ingest_exceptions', "event_id = $1 and kind = 'rejected'", [id])).toBe(1);
  });
});

describe('Scenario E (server side) — revoked device', () => {
  it('uploads from a revoked phone go to quarantine, not the ledger, and the batch says device_revoked', async () => {
    // A dedicated driver + phone so revocation does not affect other tests.
    const user = randomUUID();
    const phone = randomUUID();
    await db.admin(`insert into auth.users (id) values ($1)`, [user]);
    await db.admin(`insert into public.profiles (user_id, org_id, display_name) values ($1, $2, 'D3')`, [user, w.org]);
    await db.admin(`insert into public.user_roles (user_id, role) values ($1, 'driver')`, [user]);
    const s = { userId: user, deviceId: phone };
    await db.as(s, `select public.register_device($1, 'driver_phone')`, [phone]);
    const { trip, ev } = await tripAt(db, w, 'DISPATCHED', { id: user, s });
    const offline = [1, 2, 3].map(() => ev.sale({ actor: user }));

    await db.as(w.s.owner, `select public.revoke_device($1, 'phone lost')`, [phone]);
    const out = await ingest(db, s, offline);
    expect(out.batch).toBe('device_revoked');
    expect(out.results.map((r) => r.status)).toEqual(['quarantined', 'quarantined', 'quarantined']);
    expect(await count('trip_events', "trip_id = $1 and type = 'SALE_RECORDED'", [trip])).toBe(0);
    const q = await db.as<{ event_id: string }>(
      w.s.accounts,
      `select event_id from public.quarantined_events where device_id = $1 order by id`,
      [phone],
    );
    expect(q.map((r) => r.event_id)).toEqual(offline.map((e) => e.id));
    // The driver cannot read the quarantine.
    expect(await db.as(s, `select * from public.quarantined_events`)).toEqual([]);
  });

  it("an unregistered device or someone else's device is refused", async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    await expect(ingest(db, { userId: w.user.driver, deviceId: randomUUID() }, [ev.sale()])).rejects.toThrow(
      /not registered/,
    );
    await expect(ingest(db, { userId: w.user.driver, deviceId: w.devices.driver2 }, [ev.sale()])).rejects.toThrow(
      /another user/,
    );
  });
});

describe('clock skew at upload (D-024) and cost snapshots (Section 2 #7)', () => {
  it('a 6-hour-old offline sale from a correct clock is NOT flagged; cost is taken at occurred_at', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    const sale = { ...ev.sale(), occurredAt: new Date(Date.now() - 6 * 3600_000).toISOString() };
    const out = await ingest(db, w.s.driver, [sale]);
    expect(out).toMatchObject({ clockSkew: false, results: [{ status: 'accepted' }] });
    const [c] = await db.admin<{ as_of_basis: string; unit_cost_minor: string }>(
      `select as_of_basis, unit_cost_minor from public.sale_line_costs where event_id = $1`,
      [sale.id],
    );
    expect(c).toEqual({ as_of_basis: 'occurred_at', unit_cost_minor: 3000 });
  });

  it('a batch whose device clock is 2 hours off is flagged; costs use received_at; Accounts gets a review item', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    const sale = ev.sale();
    const out = await ingest(db, w.s.driver, [sale], { sentAt: new Date(Date.now() + 2 * 3600_000).toISOString() });
    expect(out.clockSkew).toBe(true);
    const [e] = await db.admin<{ clock_skew: boolean }>(`select clock_skew from public.trip_events where id = $1`, [
      sale.id,
    ]);
    expect(e!.clock_skew).toBe(true);
    const [c] = await db.admin<{ as_of_basis: string }>(
      `select as_of_basis from public.sale_line_costs where event_id = $1`,
      [sale.id],
    );
    expect(c!.as_of_basis).toBe('received_at');
    expect(await count('ingest_exceptions', "event_id = $1 and kind = 'clock_skew_review'", [sale.id])).toBe(1);
  });

  it('a cost change after the sale never changes the stored snapshot', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    const sale = ev.sale();
    await ingest(db, w.s.driver, [sale]);
    await db.as(
      w.s.accounts,
      `insert into public.product_costs (org_id, product_id, unit_cost_minor, currency, effective_from, entered_by)
       values ($1, $2, 9999, 'USD', now() - interval '1 day', $3)`,
      [w.org, w.ids.of('P1'), w.user.accounts],
    );
    await ingest(db, w.s.driver, [sale]); // resync
    const [c] = await db.admin<{ unit_cost_minor: string }>(
      `select unit_cost_minor from public.sale_line_costs where event_id = $1`,
      [sale.id],
    );
    expect(c!.unit_cost_minor).toBe(3000);
  });

  it('a client may not send a cost snapshot', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    const sale = ev.sale() as Extract<TripEvent, { type: 'SALE_RECORDED' }>;
    const withCost = { ...sale, lines: [{ ...sale.lines[0]!, unitCostSnapshot: { currency: 'USD', minor: 1 } }] };
    expect((await ingest(db, w.s.driver, [withCost])).results[0]!.status).toBe('rejected');
  });
});

describe('append-only ledger (Section 2 #2)', () => {
  it('no role — not even service_role or the table owner — can update or delete trip events', async () => {
    const { trip } = await tripAt(db, w, 'DISPATCHED');
    await expect(db.admin(`update public.trip_events set reason = 'x' where trip_id = $1`, [trip])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.admin(`delete from public.trip_events where trip_id = $1`, [trip])).rejects.toThrow(/append-only/);
    await expect(db.service(`delete from public.trip_events where trip_id = $1`, [trip])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.admin(`truncate public.trip_events cascade`)).rejects.toThrow(/append-only/);
    await expect(db.admin(`update public.sale_line_costs set unit_cost_minor = 0`)).rejects.toThrow(/append-only/);
    await expect(db.admin(`update public.product_costs set unit_cost_minor = 0`)).rejects.toThrow(/append-only/);
  });

  it('users cannot insert events directly; only through ingestion', async () => {
    const { trip } = await tripAt(db, w, 'DISPATCHED');
    for (const s of [w.s.owner, w.s.accounts, w.s.driver]) {
      await expect(
        db.as(
          s,
          `insert into public.trip_events (id, org_id, trip_id, type, payload, actor_id, occurred_at)
         values ($1, $2, $3, 'SALE_RECORDED', '{}', $4, now())`,
          [randomUUID(), w.org, trip, s.userId],
        ),
      ).rejects.toThrow(/row-level security/);
    }
  });

  it('a correction is a new event: the reversed sale stays in history and drops out of projections', async () => {
    const { trip, ev } = await tripAt(db, w, 'DISPATCHED');
    const sale = ev.sale();
    await ingest(db, w.s.driver, [sale]);
    const out = await ingest(db, w.s.accounts, [ev.reverse(sale.id, w.user.accounts)]);
    expect(out.results[0]!.status).toBe('accepted');
    expect(await count('trip_events', 'id = $1', [sale.id])).toBe(1);
    const [s] = await db.admin<{ reversed_by: string | null }>(`select reversed_by from public.sales where id = $1`, [
      sale.id,
    ]);
    expect(s!.reversed_by).not.toBeNull();
    // Cannot reverse twice.
    expect((await ingest(db, w.s.accounts, [ev.reverse(sale.id, w.user.accounts)])).results[0]!.status).toBe(
      'rejected',
    );
    void trip;
  });
});

describe('Scenario D5 (server side) — duplicate customers', () => {
  it('the same customer created twice offline: both exist, the second flagged as a possible duplicate', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    const a = ev.customer('+263 77 555 1234') as Extract<TripEvent, { type: 'CUSTOMER_CREATED' }>;
    const b = ev.customer('0775551234 ') as Extract<TripEvent, { type: 'CUSTOMER_CREATED' }>;
    b.phone = '+263 77 555 1234';
    const out = await ingest(db, w.s.driver, [a, b]);
    expect(out.results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
    const rows = await db.admin<{ id: string; possible_duplicate_of: string | null }>(
      `select id, possible_duplicate_of from public.customers where id in ($1, $2)`,
      [a.customerId, b.customerId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === b.customerId)!.possible_duplicate_of).toBe(a.customerId);
    // Merging is for Accounts, not the driver: the driver cannot update customers.
    const updated = await db.as(
      w.s.driver,
      `update public.customers set merged_into_id = $1 where id = $2 returning id`,
      [a.customerId, b.customerId],
    );
    expect(updated).toEqual([]);
  });
});
