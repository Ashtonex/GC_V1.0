import { describe, expect, it } from 'vitest';
import type { FxRate } from '@gc/schema';
import { FxError, convert, parseDecimal } from './fx.ts';

const rate: FxRate = { from: 'USD', to: 'ZWG', rate: '27.00', source: 'TEST', effectiveAt: '2026-01-01' };

describe('fx (integer/rational only)', () => {
  it('parses decimal strings exactly', () => {
    expect(parseDecimal('27.00')).toEqual({ num: 2700n, den: 100n });
    expect(parseDecimal('26.9575')).toEqual({ num: 269575n, den: 10000n });
    expect(() => parseDecimal('2.7e1')).toThrow(FxError);
  });

  it('ZiG 2,700.00 = USD 100.00 at the test rate (Scenario A, S2)', () => {
    expect(convert({ currency: 'ZWG', minor: 270000 }, 'USD', rate)).toEqual({
      money: { currency: 'USD', minor: 10000 },
      exact: true,
    });
  });

  it('converts in the rate direction too', () => {
    expect(convert({ currency: 'USD', minor: 10000 }, 'ZWG', rate).money).toEqual({ currency: 'ZWG', minor: 270000 });
  });

  it('rounds inexact results half away from zero and reports them as inexact', () => {
    // ZiG 1.00 / 27 = USD 0.037… → 4 cents
    expect(convert({ currency: 'ZWG', minor: 100 }, 'USD', rate)).toEqual({
      money: { currency: 'USD', minor: 4 },
      exact: false,
    });
    expect(convert({ currency: 'ZWG', minor: -100 }, 'USD', rate).money.minor).toBe(-4);
  });

  it('a decimal rate that would be inexact as a float stays exact', () => {
    const r: FxRate = { ...rate, rate: '0.1' };
    // 3 × 0.1 is 0.30000000000000004 in floats; here USD 3.00 → ZWG 0.30 exactly
    expect(convert({ currency: 'USD', minor: 300 }, 'ZWG', r)).toEqual({
      money: { currency: 'ZWG', minor: 30 },
      exact: true,
    });
  });

  it('refuses to convert without a rate or with the wrong pair', () => {
    expect(() => convert({ currency: 'ZWG', minor: 100 }, 'USD')).toThrow(FxError);
    expect(convert({ currency: 'USD', minor: 5 }, 'USD').money.minor).toBe(5);
  });
});
