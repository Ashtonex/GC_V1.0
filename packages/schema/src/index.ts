/**
 * @gc/schema — shared definitions used by the driver app, office app, engine and Edge Functions.
 * The permission matrix (`permissions.ts`) is added in M2, test-first.
 */

export const ROLES = ['owner', 'accounts', 'warehouse', 'driver'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export * from './money';
export * from './events';
