/**
 * @gc/engine — pure financial engine (Section 4, "Architecture rules"). No UI, no database.
 * Events in, results out.
 *
 *   engine.operational — selling-price totals; runs on the driver device and the server; never needs costs.
 *   engine.economics   — COGS, profit, contribution, stock at cost; SERVER ONLY.
 */
import { economics } from './economics';
import { operational } from './operational';

export const engine = { operational, economics } as const;

export { operational, computeOperational, UnsupportedError, InconsistentEventsError } from './operational';
export type {
  OperationalContext,
  OperationalResult,
  OpenItem,
  OpenItemKind,
  Ladder,
  StockRow,
  CloseCheck,
} from './operational';
export { economics, MissingCostSnapshotError } from './economics';
export type { EconomicsContext, EconomicsResult, EconomicsVerdict } from './economics';
export { prepare, ConflictingEventError, InvalidReversalError } from './ledger';
export { convert, parseDecimal, FxError } from './fx';
export type { Figure, PerCurrency } from './figure';
