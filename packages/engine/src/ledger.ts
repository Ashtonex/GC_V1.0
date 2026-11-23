import { TripEvent } from '@gc/schema';

export class ConflictingEventError extends Error {
  constructor(public readonly eventId: string) {
    super(`Conflicting resubmission: event ${eventId} arrived twice with different contents`);
  }
}
export class InvalidReversalError extends Error {}

/** Stable JSON (sorted keys) so the same event compares equal however its keys were ordered. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export interface PreparedLedger {
  /** Events that count: validated, de-duplicated, with reversed events and reversal events removed. */
  active: TripEvent[];
  /** Every distinct event, including reversals (for audit/trace). */
  all: TripEvent[];
  reversedIds: Set<string>;
}

/**
 * Validates events, applies idempotency (Section 2 #8: the same event five times counts once) and
 * reversals (Section 2 #2). A different event under an existing id is a conflict, never an overwrite (D3).
 */
export function prepare(input: readonly unknown[]): PreparedLedger {
  const byId = new Map<string, { event: TripEvent; key: string }>();
  for (const raw of input) {
    const event = TripEvent.parse(raw);
    const key = canonical(event);
    const seen = byId.get(event.id);
    if (seen) {
      if (seen.key !== key) throw new ConflictingEventError(event.id);
      continue;
    }
    byId.set(event.id, { event, key });
  }
  const all = [...byId.values()].map((v) => v.event).sort(byTime);

  const reversedIds = new Set<string>();
  for (const e of all) {
    if (e.type !== 'EVENT_REVERSED') continue;
    const target = byId.get(e.reversesEventId)?.event;
    if (!target) throw new InvalidReversalError(`${e.id} reverses unknown event ${e.reversesEventId}`);
    if (target.type === 'EVENT_REVERSED') throw new InvalidReversalError(`${e.id}: a reversal cannot be reversed`);
    if (reversedIds.has(target.id)) throw new InvalidReversalError(`${target.id} is already reversed`);
    reversedIds.add(target.id);
  }
  const active = all.filter((e) => e.type !== 'EVENT_REVERSED' && !reversedIds.has(e.id));
  return { active, all, reversedIds };
}

function byTime(a: TripEvent, b: TripEvent): number {
  return a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
