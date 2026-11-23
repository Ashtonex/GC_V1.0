/**
 * M2 gate (Section 6): Scenarios A, B, B2 and C posted through the ingest API, by the right people at the right
 * trip states, produce the same engine results as the pure M1 run. Also: projections rebuild from events.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TripEvent } from '@gc/schema';
import { economics, operational, type EconomicsContext } from '@gc/engine';
import {
  COSTS,
  PRICES,
  TRIP,
  asDeviceEvents,
  scenarioA,
  scenarioB,
  scenarioB2,
  scenarioC,
} from '../../packages/engine/src/fixtures/section6.ts';
import { TestDb, type Session } from './harness/db.ts';
import { ingest, planTrip, seedWorld, setState, toApiEvents, toNames, type World } from './harness/fixtures.ts';
import { loadServerEvents } from './harness/server-events.ts';

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await TestDb.create();
  w = await seedWorld(db);
});
afterAll(() => db.close());

type Phase = 'loading' | 'acceptance' | 'road' | 'return';

function phaseOf(e: TripEvent, original: TripEvent): Phase {
  switch (original.type) {
    case 'STOCK_HANDOVER_ISSUED':
    case 'CASH_HANDOVER_ISSUED':
      return original.direction === 'to_truck' ? 'loading' : 'return';
    case 'STOCK_HANDOVER_RESPONDED':
    case 'CASH_HANDOVER_RESPONDED':
      return original.handoverId.endsWith('-out') ? 'acceptance' : 'return';
    case 'EXPENSE_REPORTED':
      return original.expenseId === 'allowance' ? 'loading' : 'road';
    case 'EXPENSE_REVIEWED':
      return original.expenseId === 'allowance' ? 'loading' : 'return';
    case 'FUEL_READING':
      return original.reading === 'opening' ? 'acceptance' : 'road';
    case 'PAYMENT_VERIFIED':
      return 'return';
    default:
      void e;
      return 'road';
  }
}

/** Runs one scenario through the API and returns the server-side events plus the trip id. */
async function postScenario(fixture: TripEvent[]) {
  // One active trip per truck (D-007), so each scenario runs on its own truck.
  const truck = randomUUID();
  await db.admin(`insert into public.trucks (id, org_id, registration) values ($1, $2, $3)`, [truck, w.org, truck]);
  const trip = await planTrip(db, w, { truck });
  const ids = w.ids.child();
  const api = toApiEvents(fixture, ids, trip);
  const sessionFor = (actorId: string): Session =>
    Object.values(w.s).find((s) => s.userId === actorId) ?? { userId: actorId };

  const send = async (phase: Phase, extra: TripEvent[] = []) => {
    const batch = api.filter((e, i) => phaseOf(e, fixture[i]!) === phase);
    // The S3 customer is created on the phone during the sale (Section 3), just before S3.
    const all = [...extra, ...batch];
    // Group consecutive events by sender, preserving order (an outbox per person).
    for (let i = 0; i < all.length;) {
      const actor = all[i]!.actorId;
      let j = i;
      while (j < all.length && all[j]!.actorId === actor) j++;
      const out = await ingest(db, sessionFor(actor), all.slice(i, j));
      for (const r of out.results) expect(r, JSON.stringify(r)).toMatchObject({ status: 'accepted' });
      i = j;
    }
  };

  await setState(db, w.s.accounts, trip, 'LOADING');
  await send('loading');
  await setState(db, w.s.warehouse, trip, 'AWAITING_ACCEPTANCE');
  await send('acceptance');
  await setState(db, w.s.accounts, trip, 'DISPATCHED');
  const hasS3 = fixture.some((e) => e.type === 'SALE_RECORDED' && e.saleId === 'S3');
  const newCustomer: TripEvent[] = hasS3
    ? [
        {
          id: randomUUID(),
          tripId: trip,
          occurredAt: '2026-11-23T05:59:59.000Z',
          actorId: w.user.driver,
          type: 'CUSTOMER_CREATED',
          customerId: ids.of('cust-C-new'),
          name: 'Customer C',
          phone: '+263 77 123 4567',
        },
      ]
    : [];
  await send('road', newCustomer);
  await setState(db, w.s.driver, trip, 'RETURNED');
  await send('return');
  await setState(db, w.s.accounts, trip, 'RECONCILING');
  return { trip, ids, server: await loadServerEvents(db, trip) };
}

const opsCtx = { currency: 'USD', prices: PRICES } as const;
const econCtx: EconomicsContext = { ...opsCtx, costs: COSTS, costBasis: 'provisional' };

function compare(name: string, fixture: () => TripEvent[]) {
  describe(`Scenario ${name} through the ingest API`, () => {
    let result: Awaited<ReturnType<typeof postScenario>>;
    beforeAll(async () => {
      result = await postScenario(fixture());
    });

    const apiCtx = () => ({
      currency: 'USD' as const,
      prices: Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [w.ids.of(k), v])),
    });

    it('server economics (with server-written cost snapshots) equal the M1 engine run', () => {
      const ctx: EconomicsContext = {
        ...apiCtx(),
        costs: Object.fromEntries(Object.entries(COSTS).map(([k, v]) => [w.ids.of(k), v])),
        costBasis: 'provisional',
      };
      const viaApi = toNames(economics(result.server, ctx), result.ids, result.trip, TRIP);
      expect(viaApi).toEqual(economics(fixture(), econCtx));
    });

    it('operational totals from the events a driver can read equal the M1 run', async () => {
      const driverEvents = await db.as<{ payload: TripEvent }>(
        w.s.driver,
        `select payload from public.trip_events where trip_id = $1 order by seq`,
        [result.trip],
      );
      const viaApi = toNames(
        operational(
          driverEvents.map((r) => r.payload),
          apiCtx(),
        ),
        result.ids,
        result.trip,
        TRIP,
      );
      expect(viaApi).toEqual(operational(asDeviceEvents(fixture()), opsCtx));
    });

    it('projections rebuild from events to exactly the same rows (Section 4)', async () => {
      const snapshot = async () => ({
        sales: await db.admin(`select * from public.sales where trip_id = $1 order by id`, [result.trip]),
        lines: await db.admin(
          `select l.* from public.sale_lines l join public.sales s on s.id = l.sale_id where s.trip_id = $1
           order by l.sale_id, l.line_id`,
          [result.trip],
        ),
        payments: await db.admin(`select * from public.payments where trip_id = $1 order by id`, [result.trip]),
        handovers: await db.admin(`select * from public.handovers where trip_id = $1 order by id`, [result.trip]),
        expenses: await db.admin(`select * from public.expenses where trip_id = $1 order by id`, [result.trip]),
      });
      const before = await snapshot();
      expect(before.sales.length).toBeGreaterThan(0);
      await db.service(`select gc.rebuild_projections($1)`, [result.trip]);
      expect(await snapshot()).toEqual(before);
    });
  });
}

compare('A', scenarioA);
compare('B', scenarioB);
compare('B2', scenarioB2);
compare('C', scenarioC);
