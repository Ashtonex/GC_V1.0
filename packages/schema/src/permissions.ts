/**
 * Section 4B — the permission matrix, defined ONCE as data (rule 7).
 *
 * The same rules are enforced twice on the server (rule 6):
 *   1. Postgres RLS policies and SECURITY DEFINER functions (`supabase/migrations`), and
 *   2. role checks in the Edge Functions (`supabase/functions`), which read this file.
 * The UI hiding a button is never the control. Every row has an enforcement test in `supabase/tests`.
 */
import type { Role } from './roles.ts';

/**
 * yes          allowed
 * limited      allowed with limits (`limit` says which)
 * view         may read, not change
 * view_own_trip / view_cached / view_own   read-only, narrowed to the driver's own trip / cached copy / own data
 * never        must never even be readable by this role (driver and costs, Section 4B rule 5)
 * no           not allowed
 */
export type Grant = 'yes' | 'limited' | 'view' | 'view_own_trip' | 'view_cached' | 'view_own' | 'never' | 'no';

export interface Cell {
  grant: Grant;
  limit?: string;
}

export const ACTIONS = [
  'users.manage',
  'products.manage',
  'prices.set',
  'costs.set',
  'fx.enter',
  'credit_limits.set',
  'customers.create',
  'customers.edit_merge',
  'trips.plan',
  'stock.issue',
  'cash.issue',
  'handovers.respond_departure',
  'dispatch.approve',
  'sales.record',
  'discount.override',
  'sales.credit',
  'expenses.report',
  'expenses.review',
  'payments.verify',
  'returns.count',
  'cash_handover.receive',
  'corrections.record',
  'loss.confirm',
  'trips.close',
  'trips.close_with_exceptions',
  'location.view',
  'close_report.view',
  'own_trip_summary.view',
  'audit_log.view',
] as const;
export type Action = (typeof ACTIONS)[number];

const yes: Cell = { grant: 'yes' };
const no: Cell = { grant: 'no' };
const lim = (limit: string): Cell => ({ grant: 'limited', limit });
const g = (grant: Grant): Cell => ({ grant });

/** Section 4B matrix. Labels in comments are the matrix row text. */
export const PERMISSIONS: Record<Action, Record<Role, Cell>> = {
  // Create users, assign roles, revoke devices
  'users.manage': { owner: yes, accounts: no, warehouse: no, driver: no },
  // Products and pack sizes
  'products.manage': { owner: yes, accounts: yes, warehouse: g('view'), driver: g('view_own_trip') },
  // Set selling prices / price list
  'prices.set': { owner: yes, accounts: no, warehouse: no, driver: g('view_cached') },
  // Set product costs / costing method
  'costs.set': { owner: yes, accounts: yes, warehouse: no, driver: g('never') },
  // Enter daily FX rate
  'fx.enter': { owner: yes, accounts: yes, warehouse: no, driver: g('view') },
  // Set customer credit limits
  'credit_limits.set': { owner: yes, accounts: no, warehouse: no, driver: no },
  // Create customer
  'customers.create': { owner: yes, accounts: yes, warehouse: no, driver: lim('during a sale on own trip') },
  // Edit / merge customers
  'customers.edit_merge': { owner: yes, accounts: yes, warehouse: no, driver: no },
  // Create / plan trip
  'trips.plan': { owner: yes, accounts: yes, warehouse: no, driver: no },
  // Record stock issue to truck
  'stock.issue': { owner: no, accounts: no, warehouse: yes, driver: no },
  // Issue cash float / fuel money
  'cash.issue': { owner: yes, accounts: yes, warehouse: no, driver: no },
  // Accept / dispute handovers at departure
  'handovers.respond_departure': { owner: no, accounts: no, warehouse: no, driver: lim('own trip') },
  // Approve dispatch
  'dispatch.approve': { owner: yes, accounts: yes, warehouse: no, driver: no },
  // Record sales, payments, collections
  'sales.record': { owner: no, accounts: no, warehouse: no, driver: lim('own DISPATCHED trip only') },
  // Discount / price override
  'discount.override': {
    owner: yes,
    accounts: no,
    warehouse: no,
    driver: lim('off by default; only within an Owner-set % limit if enabled'),
  },
  // Credit sale
  'sales.credit': { owner: no, accounts: no, warehouse: no, driver: lim("within customer's cached limit") },
  // Report trip expense
  'expenses.report': { owner: no, accounts: no, warehouse: no, driver: yes },
  // Approve / dispute expense
  'expenses.review': { owner: yes, accounts: lim('up to Owner-set limit'), warehouse: no, driver: no },
  // Verify EcoCash / swipe / transfer
  'payments.verify': { owner: yes, accounts: yes, warehouse: no, driver: no },
  // Count returned stock (both sides required)
  'returns.count': { owner: no, accounts: no, warehouse: yes, driver: yes },
  // Receive cash handover (driver hands over)
  'cash_handover.receive': { owner: yes, accounts: yes, warehouse: no, driver: no },
  // Record correction / reversal event
  'corrections.record': {
    owner: yes,
    accounts: lim('with reason'),
    warehouse: lim('own stock events, with reason'),
    driver: lim('own unsynced draft only; after sync, request a correction'),
  },
  // Mark "Confirmed loss"
  'loss.confirm': { owner: yes, accounts: no, warehouse: no, driver: no },
  // Close trip (CLOSED)
  'trips.close': { owner: yes, accounts: yes, warehouse: no, driver: no },
  // Close with exceptions
  'trips.close_with_exceptions': { owner: yes, accounts: no, warehouse: no, driver: no },
  // View live location / trail
  'location.view': { owner: yes, accounts: yes, warehouse: no, driver: g('view_own') },
  // View trip-close report incl. margin
  'close_report.view': { owner: yes, accounts: yes, warehouse: no, driver: no },
  // View own trip summary (sales, cash expected, stock on truck)
  'own_trip_summary.view': { owner: no, accounts: no, warehouse: no, driver: yes },
  // View audit log
  'audit_log.view': { owner: yes, accounts: yes, warehouse: no, driver: no },
};

const STRENGTH: Record<Grant, number> = {
  never: 0,
  no: 1,
  view_cached: 2,
  view_own: 2,
  view_own_trip: 2,
  view: 3,
  limited: 4,
  yes: 5,
};

export interface GrantContext {
  /**
   * D-027 (approved): on a registered driver phone, the Driver role wins whatever other roles the person holds.
   * `never` always wins too: a person who is also a Driver may hold costs only off the driver phone.
   */
  driverDevice?: boolean;
}

/** The strongest grant across a person's roles (one person may hold several roles, Section 4B). */
export function bestGrant(roles: readonly Role[], action: Action, ctx: GrantContext = {}): Grant {
  const effective = ctx.driverDevice ? roles.filter((r) => r === 'driver') : roles;
  const row = PERMISSIONS[action];
  if (ctx.driverDevice && effective.length > 0 && row.driver.grant === 'never') return 'never';
  let best: Grant = 'no';
  for (const r of effective) if (STRENGTH[row[r].grant] > STRENGTH[best]) best = row[r].grant;
  return best;
}

/** True when the person may perform the action (yes or limited). Limits are checked by the server function. */
export function allows(roles: readonly Role[], action: Action, ctx: GrantContext = {}): boolean {
  const grant = bestGrant(roles, action, ctx);
  return grant === 'yes' || grant === 'limited';
}
