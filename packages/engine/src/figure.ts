import { CURRENCIES, type Currency } from '@gc/schema';

/**
 * Section 2 #9 — every number is traceable. A Figure is an amount plus the ids of the events that
 * produced it, so a report can drill down from any total to its events.
 */
export interface Figure {
  currency: Currency;
  minor: number;
  eventIds: string[];
}

export type PerCurrency = Record<Currency, Figure>;

export function figure(currency: Currency): Figure {
  return { currency, minor: 0, eventIds: [] };
}

export function perCurrency(): PerCurrency {
  return Object.fromEntries(CURRENCIES.map((c) => [c, figure(c)])) as PerCurrency;
}

export function add(f: Figure, minor: number, eventId: string): void {
  addAll(f, minor, [eventId]);
}

/** Add one amount that several events produced together (e.g. both sides of a handover). */
export function addAll(f: Figure, minor: number, eventIds: readonly string[]): void {
  const next = f.minor + minor;
  if (!Number.isSafeInteger(next)) throw new RangeError('amount out of safe integer range');
  f.minor = next;
  for (const id of eventIds) if (!f.eventIds.includes(id)) f.eventIds.push(id);
}

/** Integer multiply with an overflow guard (qty × unit price). */
export function mul(a: number, b: number): number {
  const r = a * b;
  if (!Number.isSafeInteger(r)) throw new RangeError('amount out of safe integer range');
  return r;
}
