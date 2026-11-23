/**
 * @gc/schema — shared definitions used by the driver app, office app, engine and Edge Functions.
 *
 * M0: only the role names from Section 4B. Event schemas (Zod) and the permission matrix
 * (`permissions.ts`) are added in M1/M2, test-first.
 */

export const ROLES = ['owner', 'accounts', 'warehouse', 'driver'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
