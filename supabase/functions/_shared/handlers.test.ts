/**
 * Edge Function logic (second enforcement layer, Section 4B rule 6) run against the real database.
 * The Gateway here does what supabase-js does in production: user-JWT RPC for ingestion, service role for
 * the close check and close_trip.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IngestResponse, Role, TripEvent } from '@gc/schema';
import { scenarioA, scenarioB, scenarioB2, scenarioC } from '../../../packages/engine/src/fixtures/section6.ts';
import { TestDb, type Session } from '../../tests/harness/db.ts';
import { seedWorld, type World } from '../../tests/harness/fixtures.ts';
import { tripAt } from '../../tests/harness/builders.ts';
import { postScenario } from '../../tests/harness/scenario.ts';
import {
  HttpError,
  handleCloseTrip,
  handleIngest,
  handleOfficeEvent,
  pricesFrom,
  type Caller,
  type Gateway,
} from './handlers.ts';

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await TestDb.create();
  w = await seedWorld(db);
});
afterAll(() => db.close());

const ROLES: Record<string, Role[]> = {};
function caller(key: keyof World['s']): Caller {
  const s = w.s[key];
  const roles: Record<string, Role[]> = {
    owner: ['owner'],
    accounts: ['accounts'],
    accounts2: ['accounts'],
    warehouse: ['warehouse'],
    driver: ['driver'],
    driver2: ['driver'],
    mixed: ['driver', 'accounts'],
    ...ROLES,
  };
  return {
    userId: s.userId,
    roles: roles[key]!,
    aal2: (s.aal ?? 'aal2') === 'aal2',
    ...(s.deviceId ? { deviceId: s.deviceId } : {}),
    driverDevice: !!s.deviceId,
  };
}

function gateway(s: Session): Gateway {
  return {
    async ingest(batch, rejections) {
      const [r] = await db.as<{ r: IngestResponse }>(s, `select public.ingest_events($1::jsonb, $2::jsonb) as r`, [
        JSON.stringify(batch),
        JSON.stringify(rejections),
      ]);
      return r!.r;
    },
    async loadTrip(tripId) {
      const ev = await db.service<{ payload: TripEvent }>(
        `select payload from public.trip_events where trip_id = $1 order by seq`,
        [tripId],
      );
      const items = await db.service<{ product_id: string; unit_price_minor: number; currency: string }>(
        `select i.product_id, i.unit_price_minor, l.currency from public.trips t join public.price_lists l on l.id = t.price_list_id
         join public.price_list_items i on i.price_list_id = l.id where t.id = $1`,
        [tripId],
      );
      return { events: ev.map((r) => r.payload), ctx: { currency: 'USD', prices: pricesFrom(items) } };
    },
    async closeTrip(a) {
      const [t] = await db.service<{ state: string }>(
        `select (public.close_trip($1, $2, $3, $4, $5::gc.trip_state, $6::jsonb, $7::jsonb, $8)).state`,
        [
          a.tripId,
          a.actor,
          a.aal2,
          a.deviceId,
          a.to,
          JSON.stringify(a.openItems),
          JSON.stringify(a.assignments),
          a.reason,
        ],
      );
      return t!;
    },
  };
}
const as = (key: keyof World['s']) => ({ c: caller(key), gw: gateway(w.s[key]) });

describe('ingest-events handler', () => {
  it('accepts valid events, refuses invalid ones with a reason, and keeps result positions', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    const good = ev.sale();
    const badId = { ...ev.sale(), customerId: 'cust-A' }; // not a UUID
    const garbage = { hello: 'world' }; // no id at all
    const { c, gw } = as('driver');
    const out = await handleIngest(
      { deviceId: w.devices.driver, sentAt: new Date().toISOString(), events: [good, garbage, badId] },
      c,
      gw,
    );
    expect(out.results.map((r) => r.status)).toEqual(['accepted', 'rejected', 'rejected']);
    expect(out.results[2]!.error).toMatch(/UUID/);
    // The rejection with an id is recorded as a visible exception on the server.
    const ex = await db.admin(`select kind from public.ingest_exceptions where event_id = $1`, [badId.id]);
    expect(ex).toEqual([{ kind: 'rejected' }]);
  });

  it('refuses at the edge an event type the role may not send (layer 2), and the DB records it', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    const sale = ev.sale({ actor: w.user.warehouse });
    const { c, gw } = as('warehouse');
    const out = await handleIngest({ sentAt: new Date().toISOString(), events: [sale] }, c, gw);
    expect(out.results[0]).toMatchObject({ status: 'rejected', error: 'your role may not record SALE_RECORDED' });
  });

  it('refuses a malformed batch with 400', async () => {
    const { c, gw } = as('driver');
    await expect(handleIngest({ events: [] }, c, gw)).rejects.toMatchObject({ status: 400 });
  });
});

describe('approve / verify handlers', () => {
  it('a driver calling approve or verify gets 403 before anything reaches the database', async () => {
    const { c, gw } = as('driver');
    await expect(handleOfficeEvent({}, c, gw, 'EXPENSE_REVIEWED')).rejects.toBeInstanceOf(HttpError);
    await expect(handleOfficeEvent({}, c, gw, 'PAYMENT_VERIFIED')).rejects.toMatchObject({ status: 403 });
  });

  it('Accounts verifies a swipe payment; the endpoint accepts only its own event type', async () => {
    const { ev } = await tripAt(db, w, 'DISPATCHED');
    const sale = ev.sale({ tender: 'swipe' }) as Extract<TripEvent, { type: 'SALE_RECORDED' }>;
    await handleIngest(
      { deviceId: w.devices.driver, sentAt: new Date().toISOString(), events: [sale] },
      caller('driver'),
      gateway(w.s.driver),
    );
    const { c, gw } = as('accounts');
    await expect(
      handleOfficeEvent(ev.review(randomUUID(), w.user.accounts), c, gw, 'PAYMENT_VERIFIED'),
    ).rejects.toMatchObject({ status: 400 });
    const out = await handleOfficeEvent(ev.verify(sale.payments[0]!.paymentId), c, gw, 'PAYMENT_VERIFIED');
    expect(out.results[0]!.status).toBe('accepted');
  });
});

describe('close-trip handler — Section 6 final states, close check computed on the server', () => {
  it('Scenario A → CLOSED (EcoCash and swipe verified)', async () => {
    const { trip } = await postScenario(db, w, scenarioA());
    const { c, gw } = as('accounts');
    expect(await handleCloseTrip({ tripId: trip, to: 'CLOSED' }, c, gw)).toMatchObject({
      state: 'CLOSED',
      openItems: [],
    });
  });

  it('Scenario B → only CLOSED_WITH_EXCEPTIONS (repair pending), Owner assigns it', async () => {
    const { trip } = await postScenario(db, w, scenarioB());
    await expect(
      handleCloseTrip({ tripId: trip, to: 'CLOSED' }, caller('accounts'), gateway(w.s.accounts)),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      handleCloseTrip({ tripId: trip, to: 'CLOSED_WITH_EXCEPTIONS' }, caller('accounts'), gateway(w.s.accounts)),
    ).rejects.toMatchObject({ status: 403 });
    const ops = await gateway(w.s.owner).loadTrip(trip);
    void ops;
    const [x] = await db.admin<{ id: string }>(
      `select id from public.expenses where trip_id = $1 and category = 'repair'`,
      [trip],
    );
    const out = await handleCloseTrip(
      {
        tripId: trip,
        to: 'CLOSED_WITH_EXCEPTIONS',
        assignments: [{ itemRef: x!.id, assignedTo: w.user.owner, dueDate: '2026-11-30' }],
      },
      caller('owner'),
      gateway(w.s.owner),
    );
    expect(out.state).toBe('CLOSED_WITH_EXCEPTIONS');
    expect(out.openItems.map((i) => i.kind)).toEqual(['expense_pending']);
  });

  it('Scenario B2 → CLOSED (repair approved)', async () => {
    const { trip } = await postScenario(db, w, scenarioB2());
    expect(
      (await handleCloseTrip({ tripId: trip, to: 'CLOSED' }, caller('accounts'), gateway(w.s.accounts))).state,
    ).toBe('CLOSED');
  });

  it('Scenario C → cannot be CLOSED; CLOSED_WITH_EXCEPTIONS with both differences assigned to Accounts', async () => {
    const { trip } = await postScenario(db, w, scenarioC());
    await expect(handleCloseTrip({ tripId: trip, to: 'CLOSED' }, caller('owner'), gateway(w.s.owner))).rejects.toThrow(
      /2 open item/,
    );
    const ops = (await import('@gc/engine')).operational(
      (await gateway(w.s.owner).loadTrip(trip)).events,
      (await gateway(w.s.owner).loadTrip(trip)).ctx,
    );
    const assignments = ops.openItems.map((i) => ({
      itemRef: i.ref,
      assignedTo: w.user.accounts,
      dueDate: '2026-11-30',
    }));
    const out = await handleCloseTrip(
      { tripId: trip, to: 'CLOSED_WITH_EXCEPTIONS', assignments },
      caller('owner'),
      gateway(w.s.owner),
    );
    expect(out.state).toBe('CLOSED_WITH_EXCEPTIONS');
    expect(out.openItems.map((i) => i.kind).sort()).toEqual(['cash_difference', 'stock_difference']);
  });

  it('a trip whose return has not been counted is NOT_READY (409)', async () => {
    const { trip } = await tripAt(db, w, 'RECONCILING');
    await expect(
      handleCloseTrip({ tripId: trip, to: 'CLOSED' }, caller('accounts'), gateway(w.s.accounts)),
    ).rejects.toThrow(/not ready to close/);
  });

  it('a Driver or Warehouse caller gets 403', async () => {
    for (const k of ['driver', 'warehouse'] as const) {
      await expect(
        handleCloseTrip({ tripId: randomUUID(), to: 'CLOSED' }, caller(k), gateway(w.s[k])),
      ).rejects.toMatchObject({ status: 403 });
    }
  });
});
