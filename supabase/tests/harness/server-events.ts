import type { TripEvent } from '@gc/schema';
import type { TestDb } from './db.ts';

/**
 * Server-side view of a trip's events: the stored payload with each sale line's cost snapshot (written by the
 * server at ingestion) put back on the line, ready for engine.economics. Service role only.
 */
export async function loadServerEvents(db: TestDb, tripId: string): Promise<TripEvent[]> {
  const rows = await db.service<{ payload: TripEvent; costs: Record<string, { minor: number; currency: string }> }>(
    `select e.payload,
            coalesce((select jsonb_object_agg(c.line_id, jsonb_build_object('minor', c.unit_cost_minor, 'currency', c.currency))
                      from public.sale_line_costs c where c.event_id = e.id), '{}') as costs
     from public.trip_events e where e.trip_id = $1 order by e.seq`,
    [tripId],
  );
  return rows.map(({ payload, costs }) =>
    payload.type === 'SALE_RECORDED'
      ? {
          ...payload,
          lines: payload.lines.map((l) => {
            const c = costs[l.lineId];
            return c ? { ...l, unitCostSnapshot: { currency: c.currency as 'USD', minor: Number(c.minor) } } : l;
          }),
        }
      : payload,
  );
}
