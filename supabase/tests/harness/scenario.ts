/** Posts a Section 6 scenario through the ingest API, step by step through the trip states (shared by tests). */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { TripEvent } from '@gc/schema';
import type { Session, TestDb } from './db.ts';
import { ingest, planTrip, setState, toApiEvents, type World } from './fixtures.ts';
import { loadServerEvents } from './server-events.ts';

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
export async function postScenario(db: TestDb, w: World, fixture: TripEvent[]) {
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
