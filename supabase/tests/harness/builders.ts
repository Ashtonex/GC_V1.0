/** Valid client events with UUIDs, and trips brought to a given state, for focused database tests. */
import { randomUUID } from 'node:crypto';
import type { TripEvent } from '@gc/schema';
import type { Session, TestDb } from './db.ts';
import { forceState, ingest, planTrip, setState, type World } from './fixtures.ts';

const now = () => new Date().toISOString();
const usd = (dollars: number) => ({ currency: 'USD' as const, minor: dollars * 100 });

export function makeEvents(w: World, trip: string) {
  const base = (actor: string) => ({ id: randomUUID(), tripId: trip, occurredAt: now(), actorId: actor });
  const P = (sku: 'P1' | 'P2' | 'P3') => w.ids.of(sku);
  const price = { P1: 36, P2: 24, P3: 18 } as const;
  return {
    stockIssue(
      lines: Partial<Record<'P1' | 'P2' | 'P3', number>> = { P1: 20 },
      actor = w.user.warehouse,
      direction: 'to_truck' | 'from_truck' = 'to_truck',
      handoverId = randomUUID(),
    ): TripEvent {
      return {
        ...base(actor),
        type: 'STOCK_HANDOVER_ISSUED',
        handoverId,
        direction,
        issuerId: actor,
        lines: Object.entries(lines).map(([k, qty]) => ({ productId: P(k as 'P1'), qty: qty! })),
      };
    },
    stockRespond(
      handoverId: string,
      lines: Partial<Record<'P1' | 'P2' | 'P3', number>> = { P1: 20 },
      actor = w.user.driver,
      response: 'accept' | 'accept_discrepancy' | 'dispute' = 'accept',
    ): TripEvent {
      return {
        ...base(actor),
        type: 'STOCK_HANDOVER_RESPONDED',
        handoverId,
        receiverId: actor,
        response,
        lines: Object.entries(lines).map(([k, qty]) => ({ productId: P(k as 'P1'), qty: qty! })),
      };
    },
    cashIssue(
      dollars = 100,
      actor = w.user.accounts,
      direction: 'to_truck' | 'from_truck' = 'to_truck',
      handoverId = randomUUID(),
    ): TripEvent {
      return {
        ...base(actor),
        type: 'CASH_HANDOVER_ISSUED',
        handoverId,
        direction,
        issuerId: actor,
        lines: [{ amount: usd(dollars) }],
      };
    },
    cashRespond(handoverId: string, dollars = 100, actor = w.user.driver): TripEvent {
      return {
        ...base(actor),
        type: 'CASH_HANDOVER_RESPONDED',
        handoverId,
        receiverId: actor,
        response: 'accept',
        lines: [{ amount: usd(dollars) }],
      };
    },
    /** P1 × qty paid in USD cash, exact. */
    sale(
      opts: {
        qty?: number;
        customer?: string;
        actor?: string;
        payments?: unknown[];
        discount?: number;
        unitPrice?: number;
        credit?: number;
        tender?: 'cash' | 'ecocash' | 'swipe';
      } = {},
    ): TripEvent {
      const qty = opts.qty ?? 1;
      const id = randomUUID();
      const total = qty * (opts.unitPrice ?? price.P1) - (opts.discount ?? 0);
      const credit = opts.credit ?? 0;
      const payments = opts.payments ?? [
        ...(total - credit > 0
          ? [
              {
                paymentId: randomUUID(),
                tender: opts.tender ?? 'cash',
                amount: usd(total - credit),
                ...(opts.tender && opts.tender !== 'cash' ? { reference: 'REF-1' } : {}),
              },
            ]
          : []),
        ...(credit ? [{ paymentId: randomUUID(), tender: 'credit', amount: usd(credit) }] : []),
      ];
      return {
        ...base(opts.actor ?? w.user.driver),
        id,
        type: 'SALE_RECORDED',
        saleId: id,
        customerId: opts.customer ?? w.ids.of('cust-A'),
        lines: [{ lineId: randomUUID(), productId: P('P1'), qty, unitPrice: usd(opts.unitPrice ?? price.P1) }],
        ...(opts.discount ? { discount: usd(opts.discount) } : {}),
        payments,
      } as TripEvent;
    },
    collection(dollars = 10, actor = w.user.driver): TripEvent {
      return {
        ...base(actor),
        type: 'DEBT_COLLECTED',
        collectionId: randomUUID(),
        customerId: w.ids.of('cust-E'),
        payments: [{ paymentId: randomUUID(), tender: 'cash', amount: usd(dollars) }],
      };
    },
    expense(dollars = 50, actor = w.user.driver, paidFrom: 'driver_cash' | 'office' = 'driver_cash'): TripEvent {
      return {
        ...base(actor),
        type: 'EXPENSE_REPORTED',
        expenseId: randomUUID(),
        category: 'fuel',
        amount: usd(dollars),
        paidFrom,
      };
    },
    review(
      expenseId: string,
      actor: string,
      decision: 'approved' | 'disputed' | 'evidence_reviewed' = 'approved',
    ): TripEvent {
      return { ...base(actor), type: 'EXPENSE_REVIEWED', expenseId, decision };
    },
    verify(paymentId: string, actor = w.user.accounts): TripEvent {
      return { ...base(actor), type: 'PAYMENT_VERIFIED', paymentId, result: 'verified' };
    },
    damage(actor = w.user.driver): TripEvent {
      return { ...base(actor), type: 'STOCK_DAMAGED', productId: P('P1'), qty: 1, reason: 'crushed case' };
    },
    fuel(actor = w.user.driver): TripEvent {
      return { ...base(actor), type: 'FUEL_READING', reading: 'opening', gauge: '1/2', odometerKm: 1000 };
    },
    reverse(eventId: string, actor: string): TripEvent {
      return { ...base(actor), type: 'EVENT_REVERSED', reversesEventId: eventId, reason: 'entered twice' };
    },
    customer(phone = '+263 77 999 0000', actor = w.user.driver): TripEvent {
      return { ...base(actor), type: 'CUSTOMER_CREATED', customerId: randomUUID(), name: 'New shop', phone };
    },
    loss(actor = w.user.owner): TripEvent {
      return {
        ...base(actor),
        type: 'LOSS_CONFIRMED',
        itemRef: 'cash-return:USD',
        reason: 'driver admitted shortfall',
      };
    },
  };
}

export type States = 'DRAFT' | 'LOADING' | 'AWAITING_ACCEPTANCE' | 'DISPATCHED' | 'RETURNED' | 'RECONCILING';

/**
 * A fresh trip (own truck) brought to `state` through the real state machine: stock issued by Warehouse,
 * accepted by the driver, dispatch approved by Accounts.
 */
export async function tripAt(
  db: TestDb,
  w: World,
  state: States,
  driver: { id: string; s: Session } = {
    id: w.user.driver,
    s: w.s.driver,
  },
) {
  const truck = randomUUID();
  await db.admin(`insert into public.trucks (id, org_id, registration) values ($1, $2, $3)`, [truck, w.org, truck]);
  const trip = await planTrip(db, w, { truck, driver: driver.id });
  const ev = makeEvents(w, trip);
  const order: States[] = ['DRAFT', 'LOADING', 'AWAITING_ACCEPTANCE', 'DISPATCHED', 'RETURNED', 'RECONCILING'];
  const reach = (s: States) => order.indexOf(state) >= order.indexOf(s);
  let stockOut: TripEvent | undefined;
  if (reach('LOADING')) {
    await setState(db, w.s.accounts, trip, 'LOADING');
    stockOut = ev.stockIssue({ P1: 20 });
    await expectAccepted(await ingest(db, w.s.warehouse, [stockOut]));
  }
  if (reach('AWAITING_ACCEPTANCE')) await setState(db, w.s.warehouse, trip, 'AWAITING_ACCEPTANCE');
  if (reach('DISPATCHED')) {
    const h = stockOut as Extract<TripEvent, { type: 'STOCK_HANDOVER_ISSUED' }>;
    await expectAccepted(await ingest(db, driver.s, [ev.stockRespond(h.handoverId, { P1: 20 }, driver.id)]));
    await setState(db, w.s.accounts, trip, 'DISPATCHED');
  }
  if (reach('RETURNED')) await setState(db, driver.s, trip, 'RETURNED');
  if (reach('RECONCILING')) await setState(db, w.s.accounts, trip, 'RECONCILING');
  return { trip, ev };
}

async function expectAccepted(out: { results: { status: string; error?: string }[] }) {
  for (const r of out.results) if (r.status !== 'accepted') throw new Error(`setup event not accepted: ${r.error}`);
}

export { forceState };
