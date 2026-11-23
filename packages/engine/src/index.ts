/**
 * @gc/engine — pure financial engine (Section 4, "Architecture rules"). No UI, no database.
 * Events in, results out.
 *
 *   engine.operational — selling-price totals; runs on the driver device and the server; never needs costs.
 *   engine.economics   — COGS, profit, contribution, stock at cost; SERVER ONLY.
 */
import { economics } from './economics.ts';
import { operational } from './operational.ts';

export const engine = { operational, economics } as const;

export { operational, computeOperational, UnsupportedError, InconsistentEventsError } from './operational.ts';
export type {
  OperationalContext,
  OperationalResult,
  OpenItem,
  OpenItemKind,
  Ladder,
  StockRow,
  CloseCheck,
} from './operational.ts';
export { economics, MissingCostSnapshotError } from './economics.ts';
export type { EconomicsContext, EconomicsResult, EconomicsVerdict } from './economics.ts';
export { prepare, ConflictingEventError, InvalidReversalError } from './ledger.ts';
export { convert, parseDecimal, FxError } from './fx.ts';
export type { Figure, PerCurrency } from './figure.ts';
