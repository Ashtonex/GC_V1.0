import type { Currency, FxRate, Money } from '@gc/schema';

/**
 * FX conversion with exact rational arithmetic (BigInt). No floats anywhere (Section 2 #4).
 * USD and ZWG both use 2 minor-unit digits, so minor → minor conversion is a pure ratio.
 * Rounding of inexact results: half away from zero. The rounding rule is OPEN (D-041).
 */

export class FxError extends Error {}

/** "27.00" → { num: 2700n, den: 100n } */
export function parseDecimal(s: string): { num: bigint; den: bigint } {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new FxError(`not a decimal string: ${s}`);
  const frac = m[2] ?? '';
  return { num: BigInt(m[1]! + frac), den: 10n ** BigInt(frac.length) };
}

function divRound(n: bigint, d: bigint): { value: bigint; exact: boolean } {
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = an / ad;
  const r = an % ad;
  const rounded = r * 2n >= ad ? q + 1n : q;
  return { value: neg ? -rounded : rounded, exact: r === 0n };
}

export interface Converted {
  money: Money;
  exact: boolean;
}

/** Convert `money` into `to` using `rate` (1 rate.from = rate.rate rate.to), in either direction. */
export function convert(money: Money, to: Currency, rate?: FxRate): Converted {
  if (money.currency === to) return { money, exact: true };
  if (!rate) throw new FxError(`an FX rate is needed to convert ${money.currency} to ${to}`);
  const { num, den } = parseDecimal(rate.rate);
  const minor = BigInt(money.minor);
  let result: { value: bigint; exact: boolean };
  if (rate.from === money.currency && rate.to === to) result = divRound(minor * num, den);
  else if (rate.from === to && rate.to === money.currency) result = divRound(minor * den, num);
  else throw new FxError(`rate ${rate.from}→${rate.to} cannot convert ${money.currency} to ${to}`);
  const value = Number(result.value);
  if (!Number.isSafeInteger(value)) throw new FxError('converted amount out of safe integer range');
  return { money: { currency: to, minor: value }, exact: result.exact };
}
