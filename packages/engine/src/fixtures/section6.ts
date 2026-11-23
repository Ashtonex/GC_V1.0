/**
 * Section 6 test constants and scenario event streams. TEST FIXTURES ONLY — illustrative prices, costs
 * and FX rate. Never seed these into production (Section 7).
 *
 * Events are written as the SERVER holds them after ingestion: sale lines carry `unitCostSnapshot`.
 * Use `asDeviceEvents()` to get what a driver's phone holds (no costs).
 */
import type { FxRate, Money, Payment, TripEvent } from '@gc/schema';

export const TRIP = 'trip-1';
export const ACTORS = { warehouse: 'W1', driver: 'D1', accounts: 'A1', owner: 'O1' } as const;

/** Whole units only (every Section 6 amount is whole), so ×100 stays integer arithmetic. */
function whole(units: number): number {
  if (!Number.isSafeInteger(units)) throw new Error(`fixture amounts must be whole units, got ${units}`);
  return units * 100;
}
export const usd = (dollars: number): Money => ({ currency: 'USD', minor: whole(dollars) });
export const zwg = (zig: number): Money => ({ currency: 'ZWG', minor: whole(zig) });

/** FX test rate: 1 USD = 27.00 ZiG, source "TEST". */
export const TEST_RATE: FxRate = {
  from: 'USD',
  to: 'ZWG',
  rate: '27.00',
  source: 'TEST',
  effectiveAt: '2026-01-01T00:00:00Z',
};

export const PRODUCTS = {
  P1: { name: 'Cooking oil 2L × 12 (case)', cost: usd(30), price: usd(36) },
  P2: { name: 'Sugar 2kg × 10 (bale)', cost: usd(20), price: usd(24) },
  P3: { name: 'Bath soap (case)', cost: usd(15), price: usd(18) },
} as const;
type Sku = keyof typeof PRODUCTS;

export const PRICES: Record<string, Money> = Object.fromEntries(Object.entries(PRODUCTS).map(([k, p]) => [k, p.price]));
export const COSTS: Record<string, Money> = Object.fromEntries(Object.entries(PRODUCTS).map(([k, p]) => [k, p.cost]));

// ---------------------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------------------

let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 23, 6, 0, clock++)).toISOString();
const base = (id: string, actorId: string) => ({ id, tripId: TRIP, occurredAt: at(), actorId });

type StockQty = Partial<Record<Sku, number>>;
const stockLines = (q: StockQty) => Object.entries(q).map(([productId, qty]) => ({ productId, qty: qty as number }));

function stockHandover(
  id: string,
  direction: 'to_truck' | 'from_truck',
  issuer: StockQty,
  receiver: StockQty = issuer,
): TripEvent[] {
  const [from, to] = direction === 'to_truck' ? [ACTORS.warehouse, ACTORS.driver] : [ACTORS.driver, ACTORS.warehouse];
  const response = JSON.stringify(issuer) === JSON.stringify(receiver) ? 'accept' : 'accept_discrepancy';
  return [
    {
      ...base(`${id}-issued`, from),
      type: 'STOCK_HANDOVER_ISSUED',
      handoverId: id,
      direction,
      issuerId: from,
      lines: stockLines(issuer),
    },
    {
      ...base(`${id}-responded`, to),
      type: 'STOCK_HANDOVER_RESPONDED',
      handoverId: id,
      receiverId: to,
      response,
      lines: stockLines(receiver),
    },
  ];
}

function cashHandover(
  id: string,
  direction: 'to_truck' | 'from_truck',
  issuer: { amount: Money; purpose?: string }[],
  receiver = issuer,
): TripEvent[] {
  const [from, to] = direction === 'to_truck' ? [ACTORS.accounts, ACTORS.driver] : [ACTORS.driver, ACTORS.accounts];
  const response = JSON.stringify(issuer) === JSON.stringify(receiver) ? 'accept' : 'accept_discrepancy';
  return [
    {
      ...base(`${id}-issued`, from),
      type: 'CASH_HANDOVER_ISSUED',
      handoverId: id,
      direction,
      issuerId: from,
      lines: issuer,
    },
    {
      ...base(`${id}-responded`, to),
      type: 'CASH_HANDOVER_RESPONDED',
      handoverId: id,
      receiverId: to,
      response,
      lines: receiver,
    },
  ];
}

function sale(saleId: string, customerId: string, qty: StockQty, payments: Payment[]): TripEvent {
  return {
    ...base(saleId, ACTORS.driver),
    type: 'SALE_RECORDED',
    saleId,
    customerId,
    lines: Object.entries(qty).map(([productId, n], i) => ({
      lineId: `${saleId}-L${i + 1}`,
      productId,
      qty: n as number,
      unitPrice: PRODUCTS[productId as Sku].price,
      unitCostSnapshot: PRODUCTS[productId as Sku].cost, // written by the server at ingestion
    })),
    payments,
  };
}

const pay = (paymentId: string, tender: Payment['tender'], amount: Money, extra: Partial<Payment> = {}): Payment => ({
  paymentId,
  tender,
  amount,
  ...extra,
});

function expense(
  expenseId: string,
  category: string,
  amount: Money,
  paidFrom: 'driver_cash' | 'office',
  reporter: string = ACTORS.driver,
): TripEvent {
  return {
    ...base(expenseId, reporter),
    type: 'EXPENSE_REPORTED',
    expenseId,
    category,
    amount,
    paidFrom,
    ...(paidFrom === 'driver_cash' ? { receiptPhotoPath: `receipts/${expenseId}.jpg` } : {}),
  };
}

const review = (expenseId: string, decision: 'approved' | 'disputed' | 'evidence_reviewed', by: string): TripEvent => ({
  ...base(`${expenseId}-${decision}`, by),
  type: 'EXPENSE_REVIEWED',
  expenseId,
  decision,
});

const verify = (paymentId: string): TripEvent => ({
  ...base(`${paymentId}-verified`, ACTORS.accounts),
  type: 'PAYMENT_VERIFIED',
  paymentId,
  result: 'verified',
});

const fuel = (reading: 'opening' | 'closing', gauge: string, odometerKm: number): TripEvent => ({
  ...base(`fuel-${reading}`, ACTORS.driver),
  type: 'FUEL_READING',
  reading,
  gauge,
  odometerKm,
});

// ---------------------------------------------------------------------------------------------------------
// Scenario pieces
// ---------------------------------------------------------------------------------------------------------

/** Departure common to A, B, B2 and C. */
function departure(): TripEvent[] {
  return [
    ...stockHandover('stock-out', 'to_truck', { P1: 20, P2: 30, P3: 10 }),
    ...cashHandover('cash-out', 'to_truck', [
      { amount: usd(50), purpose: 'float' },
      { amount: usd(50), purpose: 'fuel money' },
      { amount: zwg(270), purpose: 'float' },
    ]),
    // Allowance: paid by the office, a trip expense, not in driver custody. Recorded by Accounts and
    // approved by the Owner (second person). How allowances are recorded is still OPEN (D-015).
    expense('allowance', 'allowance', usd(20), 'office', ACTORS.accounts),
    review('allowance', 'approved', ACTORS.owner),
    fuel('opening', '1/2', 120_000),
  ];
}

const S1 = () => sale('S1', 'cust-A', { P1: 5, P2: 5 }, [pay('S1-pay1', 'cash', usd(300))]);
const S2 = () =>
  sale('S2', 'cust-B', { P1: 3, P2: 10 }, [
    pay('S2-pay1', 'ecocash', usd(200), { reference: 'ECO-TEST-1' }),
    pay('S2-pay2', 'cash', zwg(2700), { fxRate: TEST_RATE }),
    pay('S2-pay3', 'credit', usd(48)),
  ]);
const S3 = () => sale('S3', 'cust-C-new', { P1: 4, P3: 5 }, [pay('S3-pay1', 'cash', usd(250), { change: usd(16) })]);
const S4 = () =>
  sale('S4', 'cust-D', { P2: 6, P3: 3 }, [pay('S4-pay1', 'swipe', usd(198), { reference: 'SWP-TEST-1' })]);

/** Fuel USD 50 and toll USD 6 from driver cash, both approved by Accounts (D-019: also part of B). */
function roadExpenses(): TripEvent[] {
  return [
    expense('exp-fuel', 'fuel', usd(50), 'driver_cash'),
    expense('exp-toll', 'toll', usd(6), 'driver_cash'),
    review('exp-fuel', 'approved', ACTORS.accounts),
    review('exp-toll', 'approved', ACTORS.accounts),
  ];
}

const collectionE = (): TripEvent => ({
  ...base('COL-E', ACTORS.driver),
  type: 'DEBT_COLLECTED',
  collectionId: 'COL-E',
  customerId: 'cust-E',
  payments: [pay('COL-E-pay1', 'cash', usd(75))],
});

// ---------------------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------------------

export interface ScenarioOptions {
  /** Include the Accounts verification of EcoCash/swipe (needed for CLOSED). Default true. */
  verified?: boolean;
}

/** Scenario A — normal profitable trip. */
export function scenarioA({ verified = true }: ScenarioOptions = {}): TripEvent[] {
  return [
    ...departure(),
    S1(),
    S2(),
    S3(),
    S4(),
    collectionE(),
    ...roadExpenses(),
    fuel('closing', '1/2', 120_310),
    ...stockHandover('stock-return', 'from_truck', { P1: 8, P2: 9, P3: 2 }),
    ...cashHandover('cash-return', 'from_truck', [{ amount: usd(653) }, { amount: zwg(2970) }]),
    ...(verified ? [verify('S2-pay1'), verify('S4-pay1')] : []),
  ];
}

/** Scenario B — only S1 and S4; breakdown repair USD 120 from driver cash, approval pending. */
export function scenarioB(): TripEvent[] {
  return [
    ...departure(),
    S1(),
    S4(),
    ...roadExpenses(),
    expense('exp-repair', 'repair', usd(120), 'driver_cash'),
    fuel('closing', '1/2', 120_150),
    ...stockHandover('stock-return', 'from_truck', { P1: 15, P2: 19, P3: 7 }),
    ...cashHandover('cash-return', 'from_truck', [{ amount: usd(224) }, { amount: zwg(270) }]),
    verify('S4-pay1'),
  ];
}

/** Scenario B2 — B, then the Owner approves the repair. */
export function scenarioB2(): TripEvent[] {
  return [...scenarioB(), review('exp-repair', 'approved', ACTORS.owner)];
}

/** Scenario C — A, but USD 633 handed over (expected 653) and P3 × 1 returned (expected 2), both sides agreeing. */
export function scenarioC(): TripEvent[] {
  return scenarioA().map((e) => {
    if ((e.type === 'CASH_HANDOVER_ISSUED' || e.type === 'CASH_HANDOVER_RESPONDED') && e.handoverId === 'cash-return') {
      return { ...e, lines: [{ amount: usd(633) }, { amount: zwg(2970) }] };
    }
    if (
      (e.type === 'STOCK_HANDOVER_ISSUED' || e.type === 'STOCK_HANDOVER_RESPONDED') &&
      e.handoverId === 'stock-return'
    ) {
      return { ...e, lines: stockLines({ P1: 8, P2: 9, P3: 1 }) };
    }
    return e;
  });
}

/** What a driver's phone holds: identical events, with no cost snapshots (Section 4B rule 5). */
export function asDeviceEvents(events: TripEvent[]): TripEvent[] {
  return events.map((e) =>
    e.type === 'SALE_RECORDED'
      ? {
          ...e,
          lines: e.lines.map((line) => {
            const deviceLine = { ...line };
            delete deviceLine.unitCostSnapshot;
            return deviceLine;
          }),
        }
      : e,
  );
}
