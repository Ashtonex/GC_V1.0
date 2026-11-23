import { describe, expect, it } from 'vitest';
import { ROLES, isRole } from './index.ts';

describe('roles (Section 4B)', () => {
  it('has exactly the four V1 roles', () => {
    expect(ROLES).toEqual(['owner', 'accounts', 'warehouse', 'driver']);
  });

  it('rejects unknown roles', () => {
    expect(isRole('driver')).toBe(true);
    expect(isRole('admin')).toBe(false);
  });
});
