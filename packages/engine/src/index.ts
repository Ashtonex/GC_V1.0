/**
 * @gc/engine — pure financial engine (Section 4, "Architecture rules").
 *
 * Two outputs, built in M1:
 *   - engine.operational: selling-price totals; runs on the driver device and the server; never needs costs.
 *   - engine.economics:   COGS, profit, contribution; server only.
 *
 * M0 deliberately contains NO financial rules. Scenarios A, B, B2 and C (Section 6) are written as
 * failing tests first at the start of M1, then implemented.
 */

export const ENGINE_MILESTONE = 'M0-placeholder' as const;
