/**
 * Engine integrity tests beyond the Section 6 tables: Section 2 rules that the engine itself must hold.
 */
import { describe, expect, it } from 'vitest';
import type { TripEvent } from '@gc/schema';
import {
  ConflictingEventError,
  InvalidReversalError,
  MissingCostSnapshotError,
  economics,
  engine,
  operational,
  type EconomicsContext,
} from './index.ts';
import { ACTORS, COSTS, PRICES, TRIP, asDeviceEvents, scenarioA, scenarioB, usd } from './fixtures/section6.ts';

const opsCtx = { currency: 'USD', prices: PRICES } as const;
const econCtx: EconomicsContext = { ...opsCtx, costs: COSTS, costBasis: 'provisional' };
const ev = (id: string, rest: Record<string, unknown>) =>
  ({ id, tripId: TRIP, occurredAt: '2026-11-23T09:00:00.000Z', actorId: ACTORS.accounts, ...rest }) as TripEvent;

describe('idempotency (Section 2 #8)', () => {
  it('the same batch submitted five times gives the same result as once', () => {
    const once = economics(scenarioA(), econCtx);
    const events = scenarioA();
    const fiveTimes = economics([...events, ...events, ...events, ...events, ...events], econCtx);
    expect(fiveTimes).toEqual(once);
  });

  it('a different event under an existing id is a conflict, never an overwrite (D3)', () => {
    const events = scenarioA();
    const s1 = events.find((e) => e.id === 'S1')!;
    const changed = { ...s1, lines: s1.type === 'SALE_RECORDED' ? [{ ...s1.lines[0]!, qty: 99 }] : [] } as TripEvent;
    expect(() => operational([...events, changed], opsCtx)).toThrow(ConflictingEventError);
  });

  it('result does not depend on the order events arrive in', () => {
    const events = scenarioA();
    expect(economics([...events].reverse(), econCtx)).toEqual(economics(events, econCtx));
  });
});

describe('append-only corrections (Section 2 #2)', () => {
  it('a reversal removes the sale from totals; the sale stays in history', () => {
    const reversal = ev('REV-S1', { type: 'EVENT_REVERSED', reversesEventId: 'S1', reason: 'entered on wrong trip' });
    const r = economics([...scenarioA(), reversal], econCtx);
    expect(r.netSales).toBe(108000 - 30000);
    expect(r.operational.unitsSold).toEqual({ P1: 7, P2: 16, P3: 8 });
    expect(r.operational.cash.expected.USD.minor).toBe(65300 - 30000);
  });

  it('rejects reversing an unknown event, a reversal, or the same event twice', () => {
    const r1 = ev('R1', { type: 'EVENT_REVERSED', reversesEventId: 'S1', reason: 'x' });
    expect(() =>
      operational([...scenarioA(), ev('R0', { type: 'EVENT_REVERSED', reversesEventId: 'nope', reason: 'x' })], opsCtx),
    ).toThrow(InvalidReversalError);
    expect(() =>
      operational(
        [...scenarioA(), r1, ev('R2', { type: 'EVENT_REVERSED', reversesEventId: 'R1', reason: 'x' })],
        opsCtx,
      ),
    ).toThrow(InvalidReversalError);
    expect(() =>
      operational(
        [...scenarioA(), r1, ev('R3', { type: 'EVENT_REVERSED', reversesEventId: 'S1', reason: 'x' })],
        opsCtx,
      ),
    ).toThrow(InvalidReversalError);
  });
});

describe('cost isolation (Section 4B rule 5)', () => {
  it('operational runs on device events (no costs) and its output contains no cost or margin', () => {
    const ops = operational(asDeviceEvents(scenarioA()), opsCtx);
    expect(JSON.stringify(ops)).not.toMatch(/cost|cogs|margin|profit|contribution/i);
  });

  it('operational gives identical results with or without server cost snapshots', () => {
    expect(operational(asDeviceEvents(scenarioA()), opsCtx)).toEqual(operational(scenarioA(), opsCtx));
  });

  it('economics refuses to run without the server-written cost snapshot', () => {
    expect(() => economics(asDeviceEvents(scenarioA()), econCtx)).toThrow(MissingCostSnapshotError);
  });

  it('exposes engine.operational and engine.economics', () => {
    expect(engine.operational).toBe(operational);
    expect(engine.economics).toBe(economics);
  });
});

describe('traceability (Section 2 #9)', () => {
  const ops = operational(scenarioA(), opsCtx);

  it('net sales drills down to the four sale events', () => {
    expect(ops.netSales.eventIds.sort()).toEqual(['S1', 'S2', 'S3', 'S4']);
  });

  it('expected USD cash drills down to float, cash sales, collection and driver-cash expenses', () => {
    expect(ops.cash.expected.USD.eventIds.sort()).toEqual(
      ['COL-E', 'S1', 'S3', 'cash-out-responded', 'exp-fuel', 'exp-toll'].sort(),
    );
  });

  it('every open item names the events behind it', () => {
    const c = operational(asDeviceEvents(scenarioA({ verified: false })), opsCtx);
    for (const item of c.openItems) expect(item.eventIds.length).toBeGreaterThan(0);
  });
});

describe('handovers are two-sided (Section 2 #3)', () => {
  const withReturnCounts = (driverSays: number, warehouseSays: number) =>
    scenarioA().map((e) => {
      if (e.type === 'STOCK_HANDOVER_ISSUED' && e.handoverId === 'stock-return')
        return {
          ...e,
          lines: [
            { productId: 'P1', qty: 8 },
            { productId: 'P2', qty: 9 },
            { productId: 'P3', qty: driverSays },
          ],
        };
      if (e.type === 'STOCK_HANDOVER_RESPONDED' && e.handoverId === 'stock-return')
        return {
          ...e,
          response: 'accept_discrepancy' as const,
          lines: [
            { productId: 'P1', qty: 8 },
            { productId: 'P2', qty: 9 },
            { productId: 'P3', qty: warehouseSays },
          ],
        };
      return e;
    });

  it('keeps both counts: driver says 2, warehouse counts 1 → discrepancy + stock difference', () => {
    const ops = operational(withReturnCounts(2, 1), opsCtx);
    expect(ops.stock.P3).toMatchObject({ returned: 1, difference: 1 });
    expect(ops.openItems.map((i) => i.kind)).toEqual(['handover_discrepancy', 'stock_difference']);
  });

  it('a disputed departure handover is an open item and the stock is not treated as loaded', () => {
    const events = scenarioB().map((e) =>
      e.type === 'STOCK_HANDOVER_RESPONDED' && e.handoverId === 'stock-out'
        ? { ...e, response: 'dispute' as const }
        : e,
    );
    const ops = operational(events, opsCtx);
    expect(ops.openItems[0]).toMatchObject({ kind: 'handover_disputed', ref: 'stock-out' });
    expect(ops.stock.P1?.loaded).toBe(0);
  });

  it('a trip cannot close before the return count and cash handover', () => {
    const events = scenarioA().filter((e) => !('handoverId' in e) || !String(e.handoverId).endsWith('return'));
    expect(operational(events, opsCtx).close).toEqual({
      state: 'NOT_READY',
      missing: ['return stock count', 'cash handover'],
    });
  });
});

describe('expenses: cash follows paid-from, economics follow approval (Section 6)', () => {
  it('a disputed expense is excluded from both results, still reduces expected cash, and is an open item', () => {
    const events = [
      ...scenarioB(),
      ev('rep-disputed', {
        type: 'EXPENSE_REVIEWED',
        expenseId: 'exp-repair',
        decision: 'disputed',
        actorId: ACTORS.owner,
      }),
    ];
    const r = economics(events, econCtx);
    expect(r.pendingExpenses).toBe(0);
    expect(r.disputedExpenses).toBe(12000);
    expect(r.confirmedContribution).toBe(700);
    expect(r.provisionalContribution).toBe(700);
    expect(r.operational.cash.expected.USD.minor).toBe(22400);
    expect(r.operational.openItems.map((i) => [i.kind, i.ref])).toEqual([['expense_disputed', 'exp-repair']]);
  });

  it('an office-paid expense never touches driver custody', () => {
    const ops = operational(scenarioA(), opsCtx);
    expect(ops.expenses.find((x) => x.expenseId === 'allowance')).toMatchObject({
      paidFrom: 'office',
      status: 'approved',
    });
    expect(ops.cash.expected.USD.eventIds).not.toContain('allowance');
  });
});

describe('payments and damage', () => {
  it('a rejected EcoCash reference is an open item, not a loss', () => {
    const events = scenarioA({ verified: false }).concat([
      ev('v1', { type: 'PAYMENT_VERIFIED', paymentId: 'S2-pay1', result: 'rejected' }),
      ev('v2', { type: 'PAYMENT_VERIFIED', paymentId: 'S4-pay1', result: 'verified' }),
    ]);
    const ops = operational(events, opsCtx);
    expect(ops.openItems.map((i) => [i.kind, i.ref, i.ladder])).toEqual([['payment_rejected', 'S2-pay1', undefined]]);
  });

  it('a sale whose payments do not add up is flagged, never silently accepted', () => {
    const bad = scenarioA().map((e) =>
      e.type === 'SALE_RECORDED' && e.saleId === 'S1'
        ? { ...e, payments: [{ paymentId: 'S1-pay1', tender: 'cash' as const, amount: usd(290) }] }
        : e,
    );
    const ops = operational(bad, opsCtx);
    expect(ops.tenderCheck.balanced).toBe(false);
    expect(ops.openItems.some((i) => i.kind === 'sale_tender_mismatch' && i.ref === 'S1')).toBe(true);
  });

  it('damage is its own event: Loaded = Sold + Returned + Damaged + Difference', () => {
    const events = scenarioA().map((e) =>
      (e.type === 'STOCK_HANDOVER_ISSUED' || e.type === 'STOCK_HANDOVER_RESPONDED') && e.handoverId === 'stock-return'
        ? {
            ...e,
            lines: [
              { productId: 'P1', qty: 7 },
              { productId: 'P2', qty: 9 },
              { productId: 'P3', qty: 2 },
            ],
          }
        : e,
    );
    events.push(
      ev('dmg-1', {
        type: 'STOCK_DAMAGED',
        productId: 'P1',
        qty: 1,
        reason: 'leaking bottles',
        actorId: ACTORS.driver,
      }),
    );
    const r = economics(events, econCtx);
    expect(r.operational.stock.P1).toMatchObject({ loaded: 20, sold: 12, returned: 7, damaged: 1, difference: 0 });
    expect(r.stockAtCost).toEqual({
      loaded: 135000,
      sold: 90000,
      returned: 42000,
      damaged: 3000,
      difference: 0,
      balanced: true,
    });
    expect(r.confirmedContribution).toBe(10400); // damage treatment in economics is OPEN (D-017)
  });
});

describe('money is never a float (Section 2 #4)', () => {
  it('rejects fractional minor units at the schema boundary', () => {
    const events = scenarioA().map((e) =>
      e.type === 'SALE_RECORDED' && e.saleId === 'S1'
        ? {
            ...e,
            payments: [
              { paymentId: 'S1-pay1', tender: 'cash' as const, amount: { currency: 'USD' as const, minor: 30000.5 } },
            ],
          }
        : e,
    );
    expect(() => operational(events, opsCtx)).toThrow();
  });
});
