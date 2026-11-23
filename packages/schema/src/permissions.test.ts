/**
 * Section 4B rule 7: permissions are data. This test pins `PERMISSIONS` to the Section 4B matrix, row by row,
 * so an accidental edit fails here. The *enforcement* of every row (RLS + server functions) is tested in
 * `supabase/tests/permissions.test.ts`, which also checks that every action below has an enforcement test.
 */
import { describe, expect, it } from 'vitest';
import { ACTIONS, PERMISSIONS, allows, bestGrant, type Action } from './permissions.ts';

// Transcribed from the Section 4B table: Owner | Accounts | Warehouse | Driver.
const MATRIX: Record<Action, [string, string, string, string]> = {
  'users.manage': ['yes', 'no', 'no', 'no'],
  'products.manage': ['yes', 'yes', 'view', 'view_own_trip'],
  'prices.set': ['yes', 'no', 'no', 'view_cached'],
  'costs.set': ['yes', 'yes', 'no', 'never'],
  'fx.enter': ['yes', 'yes', 'no', 'view'],
  'credit_limits.set': ['yes', 'no', 'no', 'no'],
  'customers.create': ['yes', 'yes', 'no', 'limited'],
  'customers.edit_merge': ['yes', 'yes', 'no', 'no'],
  'trips.plan': ['yes', 'yes', 'no', 'no'],
  'stock.issue': ['no', 'no', 'yes', 'no'],
  'cash.issue': ['yes', 'yes', 'no', 'no'],
  'handovers.respond_departure': ['no', 'no', 'no', 'limited'],
  'dispatch.approve': ['yes', 'yes', 'no', 'no'],
  'sales.record': ['no', 'no', 'no', 'limited'],
  'discount.override': ['yes', 'no', 'no', 'limited'],
  'sales.credit': ['no', 'no', 'no', 'limited'],
  'expenses.report': ['no', 'no', 'no', 'yes'],
  'expenses.review': ['yes', 'limited', 'no', 'no'],
  'payments.verify': ['yes', 'yes', 'no', 'no'],
  'returns.count': ['no', 'no', 'yes', 'yes'],
  'cash_handover.receive': ['yes', 'yes', 'no', 'no'],
  'corrections.record': ['yes', 'limited', 'limited', 'limited'],
  'loss.confirm': ['yes', 'no', 'no', 'no'],
  'trips.close': ['yes', 'yes', 'no', 'no'],
  'trips.close_with_exceptions': ['yes', 'no', 'no', 'no'],
  'location.view': ['yes', 'yes', 'no', 'view_own'],
  'close_report.view': ['yes', 'yes', 'no', 'no'],
  'own_trip_summary.view': ['no', 'no', 'no', 'yes'],
  'audit_log.view': ['yes', 'yes', 'no', 'no'],
};

describe('permission matrix (Section 4B) as data', () => {
  it('has exactly the 29 rows of the Section 4B table', () => {
    expect(ACTIONS).toHaveLength(29);
    expect(new Set(ACTIONS)).toEqual(new Set(Object.keys(MATRIX)));
  });

  it.each(ACTIONS)('%s matches the matrix', (action) => {
    const row = PERMISSIONS[action];
    expect([row.owner.grant, row.accounts.grant, row.warehouse.grant, row.driver.grant]).toEqual(MATRIX[action]);
  });

  it('every limited grant states its limit', () => {
    for (const action of ACTIONS) {
      for (const cell of Object.values(PERMISSIONS[action])) {
        if (cell.grant === 'limited') expect(cell.limit, action).toBeTruthy();
      }
    }
  });

  it('drivers never see costs or margins (rule 5)', () => {
    expect(PERMISSIONS['costs.set'].driver.grant).toBe('never');
    expect(allows(['driver'], 'close_report.view')).toBe(false);
  });

  it('combined roles take the strongest grant, except on a driver phone (D-027)', () => {
    expect(bestGrant(['driver', 'accounts'], 'payments.verify')).toBe('yes');
    expect(bestGrant(['driver', 'accounts'], 'payments.verify', { driverDevice: true })).toBe('no');
    expect(bestGrant(['driver', 'owner'], 'costs.set', { driverDevice: true })).toBe('never');
    expect(bestGrant(['warehouse', 'driver'], 'returns.count')).toBe('yes');
  });

  it('allows() is true only for yes or limited (view grants are not write permissions)', () => {
    expect(allows(['warehouse'], 'products.manage')).toBe(false);
    expect(allows(['accounts'], 'expenses.review')).toBe(true);
    expect(allows([], 'trips.plan')).toBe(false);
  });
});
