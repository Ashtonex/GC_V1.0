import { CURRENCIES, type Currency, type Money } from '@gc/schema';
import { mul } from './figure';
import { convert } from './fx';
import { prepare } from './ledger';
import { computeOperational, UnsupportedError, type OperationalContext, type OperationalResult } from './operational';

/**
 * engine.economics — COGS, gross profit, direct costs, contribution, stock at cost.
 * SERVER ONLY: it needs costs, which never reach a driver's device (Section 4, Section 4B rule 5).
 *
 * Definitions are Section 6. All amounts are integer minor units in `ctx.currency`.
 */

export interface EconomicsContext extends OperationalContext {
  /** Standard cost per product, used to value loaded / returned / damaged / missing stock. */
  costs: Record<string, Money>;
  /** "provisional" until the accountant confirms the costing method (Section 6, D-006). */
  costBasis: 'provisional' | 'confirmed';
}

export type EconomicsVerdict = 'profitable' | 'break_even' | 'provisional_loss' | 'loss';

export interface EconomicsResult {
  currency: Currency;
  costBasis: 'provisional' | 'confirmed';
  netSales: number;
  /** Σ qty × frozen unit-cost snapshot on each sale line (Section 2 #7). */
  cogs: number;
  grossProfit: number;
  /** Approved trip expenses (incl. fuel purchases and allowances, see D-013/D-015). */
  approvedDirectCosts: number;
  /** Reported / evidence-reviewed, not yet approved. Only in the provisional result. */
  pendingExpenses: number;
  /** Excluded from both results; each is an open item. */
  disputedExpenses: number;
  confirmedContribution: number;
  provisionalContribution: number;
  /** Loaded = Sold + Returned + Damaged + Difference, all at standard cost. */
  stockAtCost: {
    loaded: number;
    sold: number;
    returned: number;
    damaged: number;
    difference: number;
    balanced: boolean;
  };
  /**
   * Exposure kept as separate numbers, never merged (Section 1; D-018 is OPEN on whether to show a sum).
   * cashShort: expected − received per currency (positive = short). stockAtCost: missing stock at cost.
   */
  exposure: { cashShort: Record<Currency, number>; stockAtCost: number };
  verdict: {
    economics: EconomicsVerdict;
    allAccountedFor: boolean;
    openDifferences: number;
    dataConfidence: 'verified' | 'verified_except_open_items';
  };
  /** Gauge-based consumption is approximate; its cost rule is OPEN (D-013, D-014). */
  fuel: OperationalResult['fuel'];
  operational: OperationalResult;
}

export class MissingCostSnapshotError extends Error {}

const DIFFERENCE_KINDS = new Set(['stock_difference', 'cash_difference', 'handover_discrepancy', 'handover_disputed']);

export function economics(events: readonly unknown[], ctx: EconomicsContext): EconomicsResult {
  const ledger = prepare(events);
  const ops = computeOperational(ledger, ctx);
  const R = ctx.currency;

  let cogs = 0;
  for (const e of ledger.active) {
    if (e.type !== 'SALE_RECORDED') continue;
    for (const line of e.lines) {
      const snap = line.unitCostSnapshot;
      if (!snap) throw new MissingCostSnapshotError(`sale ${e.saleId} line ${line.lineId} has no server cost snapshot`);
      if (snap.currency !== R) throw new UnsupportedError(`cost snapshot on ${e.saleId} not in ${R}`);
      cogs += mul(line.qty, snap.minor);
    }
  }

  let approved = 0;
  let pending = 0;
  let disputed = 0;
  for (const x of ops.expenses) {
    const amount = convert(x.amount, R, x.fxRate).money.minor;
    if (x.status === 'approved') approved += amount;
    else if (x.status === 'disputed') disputed += amount;
    else pending += amount;
  }

  const cost = (p: string) => {
    const c = ctx.costs[p];
    if (!c || c.currency !== R) throw new UnsupportedError(`no ${R} standard cost for ${p}`);
    return c.minor;
  };
  const s = { loaded: 0, sold: 0, returned: 0, damaged: 0, difference: 0 };
  for (const [p, row] of Object.entries(ops.stock)) {
    const c = cost(p);
    s.loaded += mul(row.loaded, c);
    s.sold += mul(row.sold, c);
    s.returned += mul(row.returned, c);
    s.damaged += mul(row.damaged, c);
    s.difference += mul(row.difference ?? row.onTruck, c);
  }
  const stockAtCost = { ...s, balanced: s.loaded === s.sold + s.returned + s.damaged + s.difference };

  const netSales = ops.netSales.minor;
  const grossProfit = netSales - cogs;
  const confirmed = grossProfit - approved;
  const provisional = confirmed - pending;

  const cashShort = Object.fromEntries(
    CURRENCIES.map((c) => [c, ops.cash.received ? ops.cash.expected[c].minor - ops.cash.received[c].minor : 0]),
  ) as Record<Currency, number>;
  const stockExposure = Object.entries(ops.stock).reduce((sum, [p, r]) => sum + mul(r.difference ?? 0, cost(p)), 0);

  const openDifferences = ops.openItems.filter((i) => DIFFERENCE_KINDS.has(i.kind)).length;

  return {
    currency: R,
    costBasis: ctx.costBasis,
    netSales,
    cogs,
    grossProfit,
    approvedDirectCosts: approved,
    pendingExpenses: pending,
    disputedExpenses: disputed,
    confirmedContribution: confirmed,
    provisionalContribution: provisional,
    stockAtCost,
    exposure: { cashShort, stockAtCost: stockExposure },
    verdict: {
      economics: verdictOf(confirmed, provisional),
      allAccountedFor: openDifferences === 0 && ops.close.state !== 'NOT_READY',
      openDifferences,
      dataConfidence: ops.openItems.length === 0 ? 'verified' : 'verified_except_open_items',
    },
    fuel: ops.fuel,
    operational: ops,
  };
}

function verdictOf(confirmed: number, provisional: number): EconomicsVerdict {
  if (confirmed < 0) return 'loss';
  if (provisional < 0) return 'provisional_loss';
  if (confirmed > 0 && provisional > 0) return 'profitable';
  return 'break_even';
}
