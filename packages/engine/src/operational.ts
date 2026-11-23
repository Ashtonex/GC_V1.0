import {
  CURRENCIES,
  NON_CASH_TENDERS,
  TENDERS,
  type Currency,
  type EventOf,
  type FxRate,
  type Money,
  type PaidFrom,
  type Payment,
  type Tender,
} from '@gc/schema';
import { add, addAll, figure, mul, perCurrency, type Figure, type PerCurrency } from './figure';
import { convert } from './fx';
import { prepare, type PreparedLedger } from './ledger';

/**
 * engine.operational — totals at SELLING prices only. Runs on the driver's device and on the server.
 * It never reads costs (Section 4 architecture rules; Section 4B rule 5).
 */

export interface OperationalContext {
  /** Currency sales are priced and reported in. Prices in other currencies are OPEN (D-020). */
  currency: Currency;
  /** Selling price per product (the driver's cached price list). Used to value stock at selling price. */
  prices: Record<string, Money>;
}

/** Section 2 #10 status ladder. Only an authorised user moves an item to `confirmed_loss` (M2). */
export type Ladder =
  | 'in_custody'
  | 'handover_pending_verification'
  | 'reconciliation_difference'
  | 'unresolved_shortage'
  | 'confirmed_loss';

export type OpenItemKind =
  | 'handover_awaiting_response'
  | 'handover_disputed'
  | 'handover_discrepancy'
  | 'stock_difference'
  | 'cash_difference'
  | 'payment_unverified'
  | 'payment_rejected'
  | 'sale_tender_mismatch'
  | 'expense_pending'
  | 'expense_disputed';

export interface OpenItem {
  kind: OpenItemKind;
  /** What the item is about: a product id, currency, payment id, expense id, sale id or handover id. */
  ref: string;
  ladder?: Ladder;
  detail: string;
  eventIds: string[];
}

export interface StockRow {
  loaded: number;
  sold: number;
  damaged: number;
  returned: number;
  /** Units on the truck now (before the return count: loaded − sold − damaged). */
  onTruck: number;
  /** loaded − sold − returned − damaged, once the return has been counted; null before. Positive = missing. */
  difference: number | null;
}

export type ExpenseStatus = 'reported' | 'evidence_reviewed' | 'approved' | 'disputed';
export interface ExpenseView {
  expenseId: string;
  category: string;
  amount: Money;
  fxRate?: FxRate;
  paidFrom: PaidFrom;
  status: ExpenseStatus;
  hasReceipt: boolean;
  eventIds: string[];
}

export interface NonCashPayment {
  paymentId: string;
  tender: Tender;
  amount: Money;
  reference?: string;
  verification: 'pending' | 'verified' | 'rejected';
  eventIds: string[];
}

export interface CloseCheck {
  state: 'NOT_READY' | 'CLOSED' | 'CLOSED_WITH_EXCEPTIONS';
  /** Why the trip is not ready to close yet (return count / cash handover missing). */
  missing: string[];
}

export interface OperationalResult {
  currency: Currency;
  netSales: Figure;
  unitsSold: Record<string, number>;
  /** Sales only: amount received per tender and currency, net of change. */
  tenders: Record<Tender, PerCurrency>;
  /** Debt collections (not sales) per tender and currency. */
  collections: Record<Tender, PerCurrency>;
  changeGiven: PerCurrency;
  tenderCheck: { paidUsdEquivalent: number; netSales: number; balanced: boolean };
  cash: {
    /** floats + cash sales − change + cash collections − driver-cash expenses (any approval status). */
    expected: PerCurrency;
    /** What the driver says they handed over (issuer side), once the cash return is recorded. */
    handedOver: PerCurrency | null;
    /** What the office counted (receiver side). */
    received: PerCurrency | null;
    /** received − expected. Negative = short. */
    variance: PerCurrency | null;
  };
  expectedInAccounts: Record<'ecocash' | 'swipe' | 'transfer', PerCurrency>;
  nonCashPayments: NonCashPayment[];
  /** Per customer, per currency: + credit given, − debt collected. */
  receivables: Record<string, PerCurrency>;
  stock: Record<string, StockRow>;
  stockValue: { loadedAtPrice: Figure; onTruckAtPrice: Figure; differenceAtPrice: Figure };
  expenses: ExpenseView[];
  fuel: {
    opening?: { gauge: string; odometerKm: number };
    closing?: { gauge: string; odometerKm: number };
    approximate: true;
  };
  openItems: OpenItem[];
  close: CloseCheck;
}

export class UnsupportedError extends Error {}
export class InconsistentEventsError extends Error {}

type Handover<I, R> = { issued?: I; responded?: R };

export function operational(events: readonly unknown[], ctx: OperationalContext): OperationalResult {
  return computeOperational(prepare(events), ctx);
}

export function computeOperational(ledger: PreparedLedger, ctx: OperationalContext): OperationalResult {
  const R = ctx.currency;
  const netSales = figure(R);
  const unitsSold: Record<string, number> = {};
  const byTender = () => Object.fromEntries(TENDERS.map((t) => [t, perCurrency()])) as Record<Tender, PerCurrency>;
  const tenders = byTender();
  const collections = byTender();
  const changeGiven = perCurrency();
  const expected = perCurrency();
  const expectedInAccounts = { ecocash: perCurrency(), swipe: perCurrency(), transfer: perCurrency() };
  const nonCash: NonCashPayment[] = [];
  const receivables: Record<string, PerCurrency> = {};
  const stockHandovers = new Map<
    string,
    Handover<EventOf<'STOCK_HANDOVER_ISSUED'>, EventOf<'STOCK_HANDOVER_RESPONDED'>>
  >();
  const cashHandovers = new Map<
    string,
    Handover<EventOf<'CASH_HANDOVER_ISSUED'>, EventOf<'CASH_HANDOVER_RESPONDED'>>
  >();
  const expenses = new Map<string, ExpenseView>();
  const verifications = new Map<string, { result: 'verified' | 'rejected'; eventId: string }>();
  const damaged: Record<string, number> = {};
  const fuel: OperationalResult['fuel'] = { approximate: true };
  const saleMismatches: OpenItem[] = [];
  let paidEquivalent = 0;

  const receivable = (customerId: string) => (receivables[customerId] ??= perCurrency());

  const takePayment = (p: Payment, eventId: string, customerId: string, isCollection: boolean) => {
    const change = p.change?.minor ?? 0;
    const net = p.amount.minor - change;
    const ccy = p.amount.currency;
    add((isCollection ? collections : tenders)[p.tender][ccy], net, eventId);
    if (change) add(changeGiven[ccy], change, eventId);
    if (p.tender === 'cash') add(expected[ccy], net, eventId);
    if (p.tender === 'credit') add(receivable(customerId)[ccy], net, eventId);
    if (isCollection) add(receivable(customerId)[ccy], -net, eventId);
    if (NON_CASH_TENDERS.includes(p.tender)) {
      add(expectedInAccounts[p.tender as 'ecocash' | 'swipe' | 'transfer'][ccy], net, eventId);
      nonCash.push({
        paymentId: p.paymentId,
        tender: p.tender,
        amount: { currency: ccy, minor: net },
        ...(p.reference ? { reference: p.reference } : {}),
        verification: 'pending',
        eventIds: [eventId],
      });
    }
    return convert({ currency: ccy, minor: net }, R, p.fxRate);
  };

  for (const e of ledger.active) {
    switch (e.type) {
      case 'STOCK_HANDOVER_ISSUED':
      case 'STOCK_HANDOVER_RESPONDED':
        slot(stockHandovers, e.handoverId, e);
        break;
      case 'CASH_HANDOVER_ISSUED':
      case 'CASH_HANDOVER_RESPONDED':
        slot(cashHandovers, e.handoverId, e);
        break;

      case 'SALE_RECORDED': {
        let total = 0;
        for (const line of e.lines) {
          if (line.unitPrice.currency !== R)
            throw new UnsupportedError(`sale ${e.saleId} is not priced in ${R} (D-020)`);
          total += mul(line.qty, line.unitPrice.minor);
          unitsSold[line.productId] = (unitsSold[line.productId] ?? 0) + line.qty;
        }
        if (e.discount) {
          if (e.discount.currency !== R) throw new UnsupportedError(`discount on ${e.saleId} not in ${R}`);
          total -= e.discount.minor;
        }
        add(netSales, total, e.id);

        let paid = 0;
        let inexact = 0;
        for (const p of e.payments) {
          const c = takePayment(p, e.id, e.customerId, false);
          paid += c.money.minor;
          if (!c.exact) inexact++;
        }
        paidEquivalent += paid;
        // Inexact FX conversions may each be off by 1 minor unit after rounding (D-041).
        if (Math.abs(paid - total) > inexact) {
          saleMismatches.push({
            kind: 'sale_tender_mismatch',
            ref: e.saleId,
            detail: `sale total ${total} but payments ${paid} (${R} minor units)`,
            eventIds: [e.id],
          });
        }
        break;
      }

      case 'DEBT_COLLECTED':
        for (const p of e.payments) takePayment(p, e.id, e.customerId, true);
        break;

      case 'EXPENSE_REPORTED':
        if (e.paidFrom === 'driver_cash') add(expected[e.amount.currency], -e.amount.minor, e.id);
        expenses.set(e.expenseId, {
          expenseId: e.expenseId,
          category: e.category,
          amount: e.amount,
          ...(e.fxRate ? { fxRate: e.fxRate } : {}),
          paidFrom: e.paidFrom,
          status: 'reported',
          hasReceipt: !!e.receiptPhotoPath,
          eventIds: [e.id],
        });
        break;

      case 'EXPENSE_REVIEWED': {
        const x = expenses.get(e.expenseId);
        if (!x) throw new InconsistentEventsError(`review ${e.id} for unknown expense ${e.expenseId}`);
        x.status = e.decision; // events are in time order, so the latest decision wins
        x.eventIds.push(e.id);
        break;
      }

      case 'PAYMENT_VERIFIED':
        verifications.set(e.paymentId, { result: e.result, eventId: e.id });
        break;

      case 'STOCK_DAMAGED':
        damaged[e.productId] = (damaged[e.productId] ?? 0) + e.qty;
        break;

      case 'FUEL_READING':
        fuel[e.reading] = { gauge: e.gauge, odometerKm: e.odometerKm };
        break;

      case 'EVENT_REVERSED':
        break; // already applied by prepare()
    }
  }

  const handoverItems: OpenItem[] = [];
  const handoverCheck = (
    id: string,
    h: Handover<{ id: string; lines: unknown[] }, { id: string; response: string; lines: unknown[] }>,
    sameCounts: boolean,
  ) => {
    if (!h.issued) throw new InconsistentEventsError(`handover ${id} has a response but no issue`);
    if (!h.responded) {
      handoverItems.push({
        kind: 'handover_awaiting_response',
        ref: id,
        ladder: 'handover_pending_verification',
        detail: 'receiver has not responded',
        eventIds: [h.issued.id],
      });
      return;
    }
    const ids = [h.issued.id, h.responded.id];
    if (h.responded.response === 'dispute') {
      handoverItems.push({
        kind: 'handover_disputed',
        ref: id,
        ladder: 'handover_pending_verification',
        detail: 'receiver disputed',
        eventIds: ids,
      });
    } else if (!sameCounts) {
      handoverItems.push({
        kind: 'handover_discrepancy',
        ref: id,
        ladder: 'handover_pending_verification',
        detail: 'issuer and receiver counts differ (both kept)',
        eventIds: ids,
      });
    }
  };

  // ---- Stock --------------------------------------------------------------------------------------------
  const loaded: Record<string, number> = {};
  const returned: Record<string, number> = {};
  const stockEventIds: Record<string, string[]> = {};
  let returnCounted = false;
  for (const [id, h] of stockHandovers) {
    const issuerQ = qtyMap(h.issued?.lines ?? []);
    const receiverQ = qtyMap(h.responded?.lines ?? []);
    handoverCheck(id, h, sameMap(issuerQ, receiverQ));
    if (!h.responded || h.responded.response === 'dispute') continue;
    const target = h.issued!.direction === 'to_truck' ? loaded : returned;
    if (h.issued!.direction === 'from_truck') returnCounted = true;
    for (const [p, q] of Object.entries(receiverQ)) {
      target[p] = (target[p] ?? 0) + q; // the receiver's count is what changed custody
      (stockEventIds[p] ??= []).push(h.issued!.id, h.responded.id);
    }
  }

  const productIds = [
    ...new Set([...Object.keys(loaded), ...Object.keys(unitsSold), ...Object.keys(damaged), ...Object.keys(returned)]),
  ].sort();
  const stock: Record<string, StockRow> = {};
  const loadedAtPrice = figure(R);
  const onTruckAtPrice = figure(R);
  const differenceAtPrice = figure(R);
  const stockItems: OpenItem[] = [];
  for (const p of productIds) {
    const row: StockRow = {
      loaded: loaded[p] ?? 0,
      sold: unitsSold[p] ?? 0,
      damaged: damaged[p] ?? 0,
      returned: returned[p] ?? 0,
      onTruck: 0,
      difference: null,
    };
    row.onTruck = row.loaded - row.sold - row.damaged - row.returned;
    const price = ctx.prices[p];
    if (!price || price.currency !== R) throw new UnsupportedError(`no ${R} selling price for ${p}`);
    const ids = stockEventIds[p] ?? [];
    addAll(loadedAtPrice, mul(row.loaded, price.minor), ids);
    if (returnCounted) {
      row.difference = row.onTruck;
      row.onTruck = 0;
      if (row.difference !== 0) {
        addAll(differenceAtPrice, mul(row.difference, price.minor), ids);
        stockItems.push({
          kind: 'stock_difference',
          ref: p,
          ladder: 'reconciliation_difference',
          detail: `${row.difference > 0 ? 'missing' : 'surplus'} ${Math.abs(row.difference)} unit(s)`,
          eventIds: ids,
        });
      }
    } else {
      addAll(onTruckAtPrice, mul(row.onTruck, price.minor), ids);
    }
    stock[p] = row;
  }

  // ---- Cash ---------------------------------------------------------------------------------------------
  let handedOver: PerCurrency | null = null;
  let received: PerCurrency | null = null;
  for (const [id, h] of cashHandovers) {
    const issuerC = cashMap(h.issued?.lines ?? []);
    const receiverC = cashMap(h.responded?.lines ?? []);
    handoverCheck(id, h, sameMap(issuerC, receiverC));
    if (!h.responded || h.responded.response === 'dispute') continue;
    if (h.issued!.direction === 'to_truck') {
      for (const [c, m] of Object.entries(receiverC)) add(expected[c as Currency], m, h.responded.id);
    } else {
      handedOver ??= perCurrency();
      received ??= perCurrency();
      for (const [c, m] of Object.entries(issuerC)) add(handedOver[c as Currency], m, h.issued!.id);
      for (const [c, m] of Object.entries(receiverC)) add(received[c as Currency], m, h.responded.id);
    }
  }
  let variance: PerCurrency | null = null;
  const cashItems: OpenItem[] = [];
  if (received) {
    variance = perCurrency();
    for (const c of CURRENCIES) {
      const v = variance[c];
      v.minor = received[c].minor - expected[c].minor;
      v.eventIds = [...received[c].eventIds, ...expected[c].eventIds];
      if (v.minor !== 0) {
        cashItems.push({
          kind: 'cash_difference',
          ref: c,
          ladder: 'reconciliation_difference',
          detail: `${v.minor < 0 ? 'short' : 'over'} ${Math.abs(v.minor)} ${c} minor units`,
          eventIds: v.eventIds,
        });
      }
    }
  }

  // ---- Payments and expenses ------------------------------------------------------------------------------
  const paymentItems: OpenItem[] = [];
  const knownPayments = new Set(nonCash.map((p) => p.paymentId));
  for (const [paymentId, v] of verifications) {
    if (!knownPayments.has(paymentId))
      throw new InconsistentEventsError(`verification ${v.eventId} for unknown non-cash payment ${paymentId}`);
  }
  for (const p of nonCash) {
    const v = verifications.get(p.paymentId);
    if (v) {
      p.verification = v.result;
      p.eventIds.push(v.eventId);
    }
    if (p.verification !== 'verified') {
      paymentItems.push({
        kind: p.verification === 'rejected' ? 'payment_rejected' : 'payment_unverified',
        ref: p.paymentId,
        detail: `${p.tender} ${p.amount.currency} ${p.amount.minor} ${p.verification === 'rejected' ? 'rejected by Accounts' : 'awaiting verification'}`,
        eventIds: p.eventIds,
      });
    }
  }

  const expenseList = [...expenses.values()];
  const expenseItems: OpenItem[] = expenseList
    .filter((x) => x.status !== 'approved')
    .map((x) => ({
      kind: x.status === 'disputed' ? ('expense_disputed' as const) : ('expense_pending' as const),
      ref: x.expenseId,
      detail: `${x.category} ${x.amount.currency} ${x.amount.minor} (${x.status})`,
      eventIds: x.eventIds,
    }));

  const openItems = [
    ...handoverItems,
    ...stockItems,
    ...cashItems,
    ...paymentItems,
    ...saleMismatches,
    ...expenseItems,
  ];

  const missing: string[] = [];
  if (!returnCounted) missing.push('return stock count');
  if (!received) missing.push('cash handover');
  const close: CloseCheck = {
    state: missing.length ? 'NOT_READY' : openItems.length ? 'CLOSED_WITH_EXCEPTIONS' : 'CLOSED',
    missing,
  };

  return {
    currency: R,
    netSales,
    unitsSold,
    tenders,
    collections,
    changeGiven,
    tenderCheck: {
      paidUsdEquivalent: paidEquivalent,
      netSales: netSales.minor,
      balanced: paidEquivalent === netSales.minor,
    },
    cash: { expected, handedOver, received, variance },
    expectedInAccounts,
    nonCashPayments: nonCash,
    receivables,
    stock,
    stockValue: { loadedAtPrice, onTruckAtPrice, differenceAtPrice },
    expenses: expenseList,
    fuel,
    openItems,
    close,
  };
}

function slot<I extends { type: string; id: string }, R extends { type: string; id: string }>(
  map: Map<string, Handover<I, R>>,
  handoverId: string,
  e: I | R,
) {
  const h = map.get(handoverId) ?? {};
  const isIssue = e.type.endsWith('_ISSUED');
  const key = isIssue ? 'issued' : 'responded';
  if (h[key]) throw new InconsistentEventsError(`handover ${handoverId} has two ${key} events; reverse one first`);
  if (isIssue) h.issued = e as I;
  else h.responded = e as R;
  map.set(handoverId, h);
}

function qtyMap(lines: readonly unknown[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const l of lines as { productId: string; qty: number }[]) m[l.productId] = (m[l.productId] ?? 0) + l.qty;
  return m;
}

function cashMap(lines: readonly unknown[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const l of lines as { amount: Money }[]) m[l.amount.currency] = (m[l.amount.currency] ?? 0) + l.amount.minor;
  return m;
}

function sameMap(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}
