import { describe, expect, it } from 'vitest';
import { ENGINE_MILESTONE } from './index';

// M0 smoke test only: proves the engine package is wired into the test runner.
// The Section 6 scenario fixtures (A, B, B2, C) are added at the start of M1.
describe('engine package', () => {
  it('is wired into the test runner', () => {
    expect(ENGINE_MILESTONE).toBe('M0-placeholder');
  });

  it.todo('Scenario A — normal profitable trip (M1)');
  it.todo('Scenario B — provisional loss, fully reconciled (M1)');
  it.todo('Scenario B2 — confirmed loss, fully reconciled (M1)');
  it.todo('Scenario C — profitable trip with open discrepancies (M1)');
});
