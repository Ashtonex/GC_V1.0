import { z } from 'zod';
import { Currency, FxRate, NonNegativeMoney } from './money.ts';

/**
 * Trip events consumed by the financial engine (M1). The ingest API (M2) validates the same schemas.
 *
 * - Every event has a client-generated `id` (Section 2 #8). M2 tightens ids to UUIDs at ingestion;
 *   the engine accepts any non-empty string so the Section 6 fixtures stay readable (S1, S2…).
 * - History is append-only (Section 2 #2): corrections are `EVENT_REVERSED` events, never edits.
 * - Handovers are two-sided (Section 2 #3): the issuer and the receiver each record their own counts.
 */

const Id = z.string().min(1);
const Qty = z.number().int().nonnegative();

const Base = {
  id: Id,
  tripId: Id,
  occurredAt: z.string().min(1), // device clock (ISO 8601)
  actorId: Id,
  deviceId: Id.optional(),
};

export const HANDOVER_RESPONSES = ['accept', 'accept_discrepancy', 'dispute'] as const;
export const HandoverResponse = z.enum(HANDOVER_RESPONSES);
export type HandoverResponse = z.infer<typeof HandoverResponse>;

/** `to_truck` = departure issue (warehouse/office → driver); `from_truck` = return (driver → warehouse/office). */
export const HandoverDirection = z.enum(['to_truck', 'from_truck']);
export type HandoverDirection = z.infer<typeof HandoverDirection>;

const StockLine = z.object({ productId: Id, qty: Qty });
const CashLine = z.object({ amount: NonNegativeMoney, purpose: z.string().min(1).optional() });

export const StockHandoverIssued = z.object({
  ...Base,
  type: z.literal('STOCK_HANDOVER_ISSUED'),
  handoverId: Id,
  direction: HandoverDirection,
  issuerId: Id,
  lines: z.array(StockLine).min(1),
});

export const StockHandoverResponded = z.object({
  ...Base,
  type: z.literal('STOCK_HANDOVER_RESPONDED'),
  handoverId: Id,
  receiverId: Id,
  response: HandoverResponse,
  lines: z.array(StockLine).min(1),
});

export const CashHandoverIssued = z.object({
  ...Base,
  type: z.literal('CASH_HANDOVER_ISSUED'),
  handoverId: Id,
  direction: HandoverDirection,
  issuerId: Id,
  lines: z.array(CashLine).min(1),
});

export const CashHandoverResponded = z.object({
  ...Base,
  type: z.literal('CASH_HANDOVER_RESPONDED'),
  handoverId: Id,
  receiverId: Id,
  response: HandoverResponse,
  lines: z.array(CashLine).min(1),
});

export const TENDERS = ['cash', 'ecocash', 'swipe', 'transfer', 'credit'] as const;
export const Tender = z.enum(TENDERS);
export type Tender = z.infer<typeof Tender>;
/** Non-cash tenders are never in driver custody; they are expected in the company account (Section 6). */
export const NON_CASH_TENDERS: readonly Tender[] = ['ecocash', 'swipe', 'transfer'];

export const Payment = z
  .object({
    paymentId: Id,
    tender: Tender,
    amount: NonNegativeMoney,
    /** Change given, recorded on the payment (Section 2 #6). Same currency as the tender (D-021 open). */
    change: NonNegativeMoney.optional(),
    /** Required when the payment currency differs from the sale/report currency. */
    fxRate: FxRate.optional(),
    reference: z.string().min(1).optional(),
  })
  .refine((p) => !p.change || p.change.currency === p.amount.currency, {
    message: 'change must be in the tender currency (D-021)',
  })
  .refine((p) => !p.change || p.change.minor <= p.amount.minor, { message: 'change cannot exceed amount' })
  .refine((p) => !p.change || p.change.minor === 0 || p.tender === 'cash', { message: 'only cash gives change' });
export type Payment = z.infer<typeof Payment>;

export const SaleLine = z.object({
  lineId: Id,
  productId: Id,
  qty: Qty.refine((q) => q > 0, 'qty must be positive'),
  unitPrice: NonNegativeMoney,
  /**
   * Section 2 #7 / Section 4: written by the SERVER at ingestion, never supplied by the driver's device.
   * Absent on device-side events. The economics engine refuses to run without it.
   */
  unitCostSnapshot: NonNegativeMoney.optional(),
});
export type SaleLine = z.infer<typeof SaleLine>;

export const SaleRecorded = z
  .object({
    ...Base,
    type: z.literal('SALE_RECORDED'),
    saleId: Id,
    customerId: Id,
    lines: z.array(SaleLine).min(1),
    /** Authorised discount on the whole sale (off by default, Section 4B). */
    discount: NonNegativeMoney.optional(),
    payments: z.array(Payment).min(1),
  })
  .refine((s) => s.lines.every((l) => l.unitPrice.currency === s.lines[0]!.unitPrice.currency), {
    message: 'all lines of a sale must be priced in one currency (D-020)',
  });

export const DebtCollected = z
  .object({
    ...Base,
    type: z.literal('DEBT_COLLECTED'),
    collectionId: Id,
    customerId: Id,
    payments: z.array(Payment).min(1),
  })
  .refine((c) => c.payments.every((p) => p.tender !== 'credit'), { message: 'a collection cannot be paid on credit' });

export const PAID_FROM = ['driver_cash', 'office', 'unpaid'] as const;
export const PaidFrom = z.enum(PAID_FROM);
export type PaidFrom = z.infer<typeof PaidFrom>;

export const ExpenseReported = z.object({
  ...Base,
  type: z.literal('EXPENSE_REPORTED'),
  expenseId: Id,
  category: z.string().min(1),
  amount: NonNegativeMoney,
  paidFrom: PaidFrom,
  receiptPhotoPath: z.string().min(1).optional(),
  fxRate: FxRate.optional(),
});

export const EXPENSE_DECISIONS = ['evidence_reviewed', 'approved', 'disputed'] as const;
export const ExpenseReviewed = z.object({
  ...Base,
  type: z.literal('EXPENSE_REVIEWED'),
  expenseId: Id,
  decision: z.enum(EXPENSE_DECISIONS),
  reason: z.string().min(1).optional(),
});

export const PaymentVerified = z.object({
  ...Base,
  type: z.literal('PAYMENT_VERIFIED'),
  paymentId: Id,
  result: z.enum(['verified', 'rejected']),
  reference: z.string().min(1).optional(),
});

/** Damage is its own event type (Section 3). */
export const StockDamaged = z.object({
  ...Base,
  type: z.literal('STOCK_DAMAGED'),
  productId: Id,
  qty: Qty.refine((q) => q > 0, 'qty must be positive'),
  reason: z.string().min(1),
});

/** Gauge as a fraction string ("1/2", "3/4"). Consumption from gauges is approximate (Section 3; D-013, D-014). */
export const FuelReading = z.object({
  ...Base,
  type: z.literal('FUEL_READING'),
  reading: z.enum(['opening', 'closing']),
  gauge: z.string().regex(/^\d+\/\d+$/, 'gauge like "1/2"'),
  odometerKm: z.number().int().nonnegative(),
});

/** Section 2 #2 — a correction is a new event with a reason; the reversed event stays in history. */
export const EventReversed = z.object({
  ...Base,
  type: z.literal('EVENT_REVERSED'),
  reversesEventId: Id,
  reason: z.string().min(1),
});

/**
 * A customer created by the driver during a sale on their own trip (Section 3). The id is generated on the
 * phone so the sale can reference it offline. Duplicate detection (same phone) runs on the server at sync.
 */
export const CustomerCreated = z.object({
  ...Base,
  type: z.literal('CUSTOMER_CREATED'),
  customerId: Id,
  name: z.string().min(1),
  phone: z.string().min(1).optional(),
  businessType: z.string().min(1).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

/**
 * Section 2 #10: only the Owner may move an item to "Confirmed loss". `itemRef` names the open item
 * (e.g. a handover id + product, or a cash handover id + currency). The ladder steps before it are M7 (D-040).
 */
export const LossConfirmed = z.object({
  ...Base,
  type: z.literal('LOSS_CONFIRMED'),
  itemRef: z.string().min(1),
  reason: z.string().min(1),
});

export const TRIP_STATES = [
  'DRAFT',
  'LOADING',
  'AWAITING_ACCEPTANCE',
  'DISPATCHED',
  'RETURNED',
  'RECONCILING',
  'CLOSED',
  'CLOSED_WITH_EXCEPTIONS',
] as const;
export const TripState = z.enum(TRIP_STATES);
export type TripState = z.infer<typeof TripState>;

/** Written by the server when a trip changes state (audit trail). Never accepted from a client. */
export const TripStatusChanged = z.object({
  ...Base,
  type: z.literal('TRIP_STATUS_CHANGED'),
  from: TripState,
  to: TripState,
  reason: z.string().min(1).optional(),
});

export const TripEvent = z.union([
  StockHandoverIssued,
  StockHandoverResponded,
  CashHandoverIssued,
  CashHandoverResponded,
  SaleRecorded,
  DebtCollected,
  ExpenseReported,
  ExpenseReviewed,
  PaymentVerified,
  StockDamaged,
  FuelReading,
  EventReversed,
  CustomerCreated,
  LossConfirmed,
  TripStatusChanged,
]);
export type TripEvent = z.infer<typeof TripEvent>;
export type TripEventType = TripEvent['type'];
export type EventOf<T extends TripEventType> = Extract<TripEvent, { type: T }>;

/** Currency of a value, re-exported for convenience in event code. */
export type EventCurrency = z.infer<typeof Currency>;
