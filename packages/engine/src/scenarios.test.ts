/**
 * M1 gate: Section 6 Scenarios A, B, B2 and C as pure engine tests (fixtures in, results out).
 * Every figure in the Section 6 tables is asserted here, in integer minor units (cents).
 */
import { describe, expect, it } from 'vitest';
import { economics, operational, type EconomicsContext } from './index';
import { COSTS, PRICES, asDeviceEvents, scenarioA, scenarioB, scenarioB2, scenarioC } from './fixtures/section6';

const opsCtx = { currency: 'USD', prices: PRICES } as const;
const econCtx: EconomicsContext = { ...opsCtx, costs: COSTS, costBasis: 'provisional' };

/** Run both engines; operational runs on device-side events (no costs) exactly as the phone would. */
function run(events: ReturnType<typeof scenarioA>) {
  return { ops: operational(asDeviceEvents(events), opsCtx), econ: economics(events, econCtx) };
}

describe('Scenario A — normal profitable trip (golden test)', () => {
  const { ops, econ } = run(scenarioA());

  it('departure: stock at cost $1,350.00 and at selling value $1,620.00', () => {
    expect(econ.stockAtCost.loaded).toBe(135000);
    expect(ops.stockValue.loadedAtPrice.minor).toBe(162000);
  });

  it('units sold: P1 12, P2 21, P3 8', () => {
    expect(ops.unitsSold).toEqual({ P1: 12, P2: 21, P3: 8 });
  });

  it('net sales $1,080.00, COGS $900.00, gross profit $180.00', () => {
    expect(ops.netSales.minor).toBe(108000);
    expect(econ.netSales).toBe(108000);
    expect(econ.cogs).toBe(90000);
    expect(econ.grossProfit).toBe(18000);
  });

  it('trip direct costs $76.00 (fuel 50 + toll 6 + allowance 20); contribution $104.00', () => {
    expect(econ.approvedDirectCosts).toBe(7600);
    expect(econ.pendingExpenses).toBe(0);
    expect(econ.confirmedContribution).toBe(10400);
    expect(econ.provisionalContribution).toBe(10400);
  });

  it('stock returned P1 8, P2 9, P3 2 = $450.00 at cost; stock check balances', () => {
    expect(ops.stock.P1).toMatchObject({ loaded: 20, sold: 12, returned: 8, damaged: 0, difference: 0 });
    expect(ops.stock.P2).toMatchObject({ loaded: 30, sold: 21, returned: 9, damaged: 0, difference: 0 });
    expect(ops.stock.P3).toMatchObject({ loaded: 10, sold: 8, returned: 2, damaged: 0, difference: 0 });
    expect(econ.stockAtCost).toEqual({
      loaded: 135000,
      sold: 90000,
      returned: 45000,
      damaged: 0,
      difference: 0,
      balanced: true,
    });
  });

  it('expected cash in custody: USD 653.00 and ZiG 2,970.00', () => {
    expect(ops.cash.expected.USD.minor).toBe(65300);
    expect(ops.cash.expected.ZWG.minor).toBe(297000);
  });

  it('expected in company accounts: EcoCash USD 200.00, Swipe USD 198.00', () => {
    expect(ops.expectedInAccounts.ecocash.USD.minor).toBe(20000);
    expect(ops.expectedInAccounts.swipe.USD.minor).toBe(19800);
    expect(ops.expectedInAccounts.transfer.USD.minor).toBe(0);
  });

  it('receivables: Customer B +$48.00, Customer E −$75.00', () => {
    expect(ops.receivables['cust-B']?.USD.minor).toBe(4800);
    expect(ops.receivables['cust-E']?.USD.minor).toBe(-7500);
  });

  it('tender check: 300 + 234 + 200 + 100 + 198 + 48 = 1,080', () => {
    expect(ops.tenderCheck).toEqual({ paidUsdEquivalent: 108000, netSales: 108000, balanced: true });
    expect(ops.tenders.cash.USD.minor).toBe(30000 + 23400); // S1 300 + S3 (250 − 16 change)
    expect(ops.tenders.cash.ZWG.minor).toBe(270000);
    expect(ops.tenders.credit.USD.minor).toBe(4800);
    expect(ops.changeGiven.USD.minor).toBe(1600);
    expect(ops.collections.cash.USD.minor).toBe(7500); // Customer E, kept apart from sales
  });

  it('driver hands over USD 653.00, ZiG 2,970.00 → variance 0 / 0', () => {
    expect(ops.cash.received?.USD.minor).toBe(65300);
    expect(ops.cash.received?.ZWG.minor).toBe(297000);
    expect(ops.cash.variance?.USD.minor).toBe(0);
    expect(ops.cash.variance?.ZWG.minor).toBe(0);
  });

  it('final state CLOSED after EcoCash and swipe are verified', () => {
    expect(ops.openItems).toEqual([]);
    expect(ops.close.state).toBe('CLOSED');
  });

  it('before verification the two non-cash payments are open items', () => {
    const before = operational(asDeviceEvents(scenarioA({ verified: false })), opsCtx);
    expect(before.openItems.map((i) => [i.kind, i.ref])).toEqual([
      ['payment_unverified', 'S2-pay1'],
      ['payment_unverified', 'S4-pay1'],
    ]);
    expect(before.close.state).toBe('CLOSED_WITH_EXCEPTIONS');
  });

  it('verdict: profitable, all resources accounted for, cost basis provisional', () => {
    expect(econ.verdict).toEqual({
      economics: 'profitable',
      allAccountedFor: true,
      openDifferences: 0,
      dataConfidence: 'verified',
    });
    expect(econ.costBasis).toBe('provisional');
  });
});

describe('Scenario B — provisional loss, fully reconciled', () => {
  const { ops, econ } = run(scenarioB());

  it('units sold P1 5, P2 11, P3 3; net sales $498.00; COGS $415.00; gross profit $83.00', () => {
    expect(ops.unitsSold).toEqual({ P1: 5, P2: 11, P3: 3 });
    expect(econ.netSales).toBe(49800);
    expect(econ.cogs).toBe(41500);
    expect(econ.grossProfit).toBe(8300);
  });

  it('approved costs $76.00; pending repair $120.00 shown separately', () => {
    expect(econ.approvedDirectCosts).toBe(7600);
    expect(econ.pendingExpenses).toBe(12000);
    expect(econ.disputedExpenses).toBe(0);
  });

  it('confirmed contribution +$7.00; provisional contribution −$113.00', () => {
    expect(econ.confirmedContribution).toBe(700);
    expect(econ.provisionalContribution).toBe(-11300);
  });

  it('stock returned P1 15, P2 19, P3 7 = $935.00 at cost; 1,350 = 415 + 935', () => {
    expect(econ.stockAtCost).toEqual({
      loaded: 135000,
      sold: 41500,
      returned: 93500,
      damaged: 0,
      difference: 0,
      balanced: true,
    });
  });

  it('expected cash USD 224.00 (repair counts though pending) and ZiG 270.00; swipe USD 198.00 in accounts', () => {
    expect(ops.cash.expected.USD.minor).toBe(22400);
    expect(ops.cash.expected.ZWG.minor).toBe(27000);
    expect(ops.expectedInAccounts.swipe.USD.minor).toBe(19800);
    expect(ops.expectedInAccounts.ecocash.USD.minor).toBe(0);
  });

  it('handover USD 224.00, ZiG 270.00 → variance 0 / 0', () => {
    expect(ops.cash.variance?.USD.minor).toBe(0);
    expect(ops.cash.variance?.ZWG.minor).toBe(0);
  });

  it('verdict: provisional loss, all resources accounted for; action: Owner reviews the repair', () => {
    expect(econ.verdict.economics).toBe('provisional_loss');
    expect(econ.verdict.allAccountedFor).toBe(true);
    expect(ops.openItems.map((i) => [i.kind, i.ref])).toEqual([['expense_pending', 'exp-repair']]);
  });

  it('final state CLOSED_WITH_EXCEPTIONS while the repair is pending', () => {
    expect(ops.close.state).toBe('CLOSED_WITH_EXCEPTIONS');
  });
});

describe('Scenario B2 — confirmed loss, fully reconciled', () => {
  const { ops, econ } = run(scenarioB2());

  it('approved costs $196.00; pending $0.00', () => {
    expect(econ.approvedDirectCosts).toBe(19600);
    expect(econ.pendingExpenses).toBe(0);
  });

  it('confirmed and provisional contribution both −$113.00', () => {
    expect(econ.confirmedContribution).toBe(-11300);
    expect(econ.provisionalContribution).toBe(-11300);
  });

  it('cash unchanged from B: USD 224.00, ZiG 270.00, variance 0 / 0', () => {
    expect(ops.cash.expected.USD.minor).toBe(22400);
    expect(ops.cash.expected.ZWG.minor).toBe(27000);
    expect(ops.cash.variance?.USD.minor).toBe(0);
    expect(ops.cash.variance?.ZWG.minor).toBe(0);
  });

  it('poor trip economics, not poor accountability: loss (confirmed), all accounted for, CLOSED', () => {
    expect(econ.verdict).toEqual({
      economics: 'loss',
      allAccountedFor: true,
      openDifferences: 0,
      dataConfidence: 'verified',
    });
    expect(ops.openItems).toEqual([]);
    expect(ops.close.state).toBe('CLOSED');
  });
});

describe('Scenario C — profitable trip with open discrepancies', () => {
  const { ops, econ } = run(scenarioC());

  it('contribution stays $104.00: discrepancies are not costs until confirmed', () => {
    expect(econ.confirmedContribution).toBe(10400);
    expect(econ.provisionalContribution).toBe(10400);
  });

  it('cash: reconciliation difference USD 20.00, ZiG 0', () => {
    expect(ops.cash.variance?.USD.minor).toBe(-2000);
    expect(ops.cash.variance?.ZWG.minor).toBe(0);
    expect(econ.exposure.cashShort).toEqual({ USD: 2000, ZWG: 0 });
  });

  it('stock: reconciliation difference P3 × 1 = $15.00 at cost ($18.00 at selling value)', () => {
    expect(ops.stock.P3).toMatchObject({ loaded: 10, sold: 8, returned: 1, difference: 1 });
    expect(ops.stockValue.differenceAtPrice.minor).toBe(1800);
    expect(econ.exposure.stockAtCost).toBe(1500);
  });

  it('stock check: 1,350 = 900 sold + 435 returned + 0 damaged + 15 difference', () => {
    expect(econ.stockAtCost).toEqual({
      loaded: 135000,
      sold: 90000,
      returned: 43500,
      damaged: 0,
      difference: 1500,
      balanced: true,
    });
  });

  it('both differences are on the ladder at "Reconciliation difference" — no accusation', () => {
    expect(ops.openItems.map((i) => [i.kind, i.ref, i.ladder])).toEqual([
      ['stock_difference', 'P3', 'reconciliation_difference'],
      ['cash_difference', 'USD', 'reconciliation_difference'],
    ]);
  });

  it('cannot be CLOSED; only CLOSED_WITH_EXCEPTIONS', () => {
    expect(ops.close.state).toBe('CLOSED_WITH_EXCEPTIONS');
  });

  it('verdict: profitable; 2 open differences; verified except open items', () => {
    expect(econ.verdict).toEqual({
      economics: 'profitable',
      allAccountedFor: false,
      openDifferences: 2,
      dataConfidence: 'verified_except_open_items',
    });
  });
});
