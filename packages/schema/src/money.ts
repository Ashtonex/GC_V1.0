import { z } from 'zod';

/**
 * Section 2 #4 — money is never a float.
 * Amounts are integer minor units (cents) plus an ISO 4217 code. Zimbabwe Gold (ZiG) is ISO `ZWG`;
 * the UI shows it as "ZiG".
 */
export const CURRENCIES = ['USD', 'ZWG'] as const;
export const Currency = z.enum(CURRENCIES);
export type Currency = z.infer<typeof Currency>;

export const CURRENCY_LABEL: Record<Currency, string> = { USD: 'USD', ZWG: 'ZiG' };

/** Integer minor units. Safe-integer bound keeps every value exact in JS numbers. */
export const MinorUnits = z.number().int().refine(Number.isSafeInteger, 'must be a safe integer');

export const Money = z.object({
  currency: Currency,
  minor: MinorUnits,
});
export type Money = z.infer<typeof Money>;

export const NonNegativeMoney = Money.refine((m) => m.minor >= 0, 'amount must not be negative');

/** A positive decimal written as a string, e.g. "27.00". Never parsed into a float. */
export const DecimalString = z.string().regex(/^\d+(\.\d+)?$/, 'must be a decimal string like "27.00"');

/**
 * FX rate: 1 unit of `from` = `rate` units of `to`. Stored as a decimal string together with its source
 * and timestamp (Section 2 #4). Which rate a trip uses (trip rate vs daily) is still OPEN (Section 10, D-025).
 */
export const FxRate = z
  .object({
    from: Currency,
    to: Currency,
    rate: DecimalString,
    source: z.string().min(1),
    effectiveAt: z.string().min(1),
    rateId: z.string().min(1).optional(),
  })
  .refine((r) => r.from !== r.to, 'from and to must differ')
  .refine((r) => !/^0+(\.0+)?$/.test(r.rate), 'rate must be greater than zero');
export type FxRate = z.infer<typeof FxRate>;
