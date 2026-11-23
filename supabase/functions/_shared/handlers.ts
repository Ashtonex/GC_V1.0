/**
 * Edge Function logic, independent of the Deno runtime so it can be tested against the real database.
 * Each function's index.ts builds a `Caller` from the verified JWT and a `Gateway` from supabase-js, then
 * calls one of these handlers.
 *
 * Section 4B rule 6: this is the SECOND enforcement layer. The database (RLS + SECURITY DEFINER functions)
 * applies every rule again; this layer refuses early using the shared matrix in @gc/schema.
 */
import {
  IngestBatch,
  allows,
  mayPostEvent,
  parseIngestEvent,
  type IngestResponse,
  type Money,
  type Role,
  type TripEvent,
} from '@gc/schema';
import { operational, type OperationalContext } from '@gc/engine';

export interface Caller {
  userId: string;
  /** Roles held (user_roles). */
  roles: Role[];
  /** Two-factor session (Owner powers need it). */
  aal2: boolean;
  /** Device id from the x-gc-device-id header, if any. */
  deviceId?: string;
  /** True when deviceId is this user's registered driver phone (D-027: driver powers only). */
  driverDevice: boolean;
}

export interface TripData {
  events: TripEvent[];
  ctx: OperationalContext;
}

export interface Gateway {
  /** public.ingest_events called WITH THE USER'S JWT (so auth.uid() is the caller). */
  ingest(batch: unknown, rejections: Record<string, string>): Promise<IngestResponse>;
  /** Service role: the trip's events (payloads) and selling prices, for the engine's close check. */
  loadTrip(tripId: string): Promise<TripData>;
  /** Service role: public.close_trip. */
  closeTrip(args: {
    tripId: string;
    actor: string;
    aal2: boolean;
    deviceId: string | null;
    to: 'CLOSED' | 'CLOSED_WITH_EXCEPTIONS';
    openItems: { ref: string; kind: string; detail: string }[];
    assignments: { itemRef: string; assignedTo: string; dueDate: string }[];
    reason: string | null;
  }): Promise<{ state: string }>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Effective roles: Owner only with aal2; Driver only on a driver phone (D-027). */
export function effectiveRoles(c: Caller): Role[] {
  return c.roles.filter((r) => (r !== 'owner' || c.aal2) && (!c.driverDevice || r === 'driver'));
}

// ---------------------------------------------------------------------------------------------------------
// ingest-events
// ---------------------------------------------------------------------------------------------------------
export async function handleIngest(body: unknown, caller: Caller, gw: Gateway): Promise<IngestResponse> {
  const parsed = IngestBatch.safeParse(body);
  if (!parsed.success) throw new HttpError(400, `invalid batch: ${parsed.error.issues[0]?.message ?? ''}`);
  if (parsed.data.deviceId && caller.deviceId && parsed.data.deviceId !== caller.deviceId) {
    throw new HttpError(400, 'batch deviceId does not match the x-gc-device-id header');
  }
  const roles = effectiveRoles(caller);
  const rejections: Record<string, string> = {};
  const events: unknown[] = [];
  const local: { index: number; id: string | null; error: string }[] = [];
  parsed.data.events.forEach((raw, index) => {
    const ev = parseIngestEvent(raw);
    if (!ev.ok) {
      // Recorded server-side as a visible exception when it has an id; otherwise answered here only.
      if (ev.id) {
        rejections[ev.id] = ev.error;
        events.push(raw);
      } else local.push({ index, id: null, error: ev.error });
      return;
    }
    if (!mayPostEvent(roles, ev.event.type, { driverDevice: caller.driverDevice })) {
      rejections[ev.event.id] = `your role may not record ${ev.event.type}`;
    }
    events.push(raw);
  });
  if (events.length === 0) {
    return {
      batch: 'ok',
      clockSkew: false,
      results: local.map((l) => ({ id: null, status: 'rejected', error: l.error })),
    };
  }
  const res = await gw.ingest({ ...parsed.data, events }, rejections);
  // Re-insert id-less local rejections at their original positions.
  const results = [...res.results];
  for (const l of local) results.splice(l.index, 0, { id: null, status: 'rejected', error: l.error });
  return { ...res, results };
}

// ---------------------------------------------------------------------------------------------------------
// approve (expense review) and verify (payment verification): one office event each, through ingestion.
// ---------------------------------------------------------------------------------------------------------
export async function handleOfficeEvent(
  body: unknown,
  caller: Caller,
  gw: Gateway,
  type: 'EXPENSE_REVIEWED' | 'PAYMENT_VERIFIED',
): Promise<IngestResponse> {
  const action = type === 'EXPENSE_REVIEWED' ? 'expenses.review' : 'payments.verify';
  if (!allows(effectiveRoles(caller), action, { driverDevice: caller.driverDevice })) {
    throw new HttpError(403, `your role may not perform ${action}`);
  }
  const ev = parseIngestEvent(body);
  if (!ev.ok) throw new HttpError(400, ev.error);
  if (ev.event.type !== type) throw new HttpError(400, `this endpoint only accepts ${type}`);
  return gw.ingest({ sentAt: new Date().toISOString(), events: [body] }, {});
}

// ---------------------------------------------------------------------------------------------------------
// close-trip: the engine's close check runs on the server; the caller cannot supply the open items.
// ---------------------------------------------------------------------------------------------------------
export interface CloseRequest {
  tripId: string;
  to: 'CLOSED' | 'CLOSED_WITH_EXCEPTIONS';
  assignments?: { itemRef: string; assignedTo: string; dueDate: string }[];
  reason?: string;
}

export async function handleCloseTrip(body: unknown, caller: Caller, gw: Gateway) {
  const req = body as CloseRequest;
  if (!req || typeof req.tripId !== 'string' || !['CLOSED', 'CLOSED_WITH_EXCEPTIONS'].includes(req.to)) {
    throw new HttpError(400, 'expected { tripId, to: CLOSED | CLOSED_WITH_EXCEPTIONS }');
  }
  const action = req.to === 'CLOSED' ? 'trips.close' : 'trips.close_with_exceptions';
  if (!allows(effectiveRoles(caller), action, { driverDevice: caller.driverDevice })) {
    throw new HttpError(403, `your role may not perform ${action}`);
  }
  const trip = await gw.loadTrip(req.tripId);
  const ops = operational(trip.events, trip.ctx);
  if (ops.close.state === 'NOT_READY') {
    throw new HttpError(409, `trip is not ready to close: ${ops.close.missing.join('; ')}`);
  }
  if (req.to === 'CLOSED' && ops.close.state !== 'CLOSED') {
    throw new HttpError(409, `trip has ${ops.openItems.length} open item(s): it can only be closed with exceptions`);
  }
  const t = await gw.closeTrip({
    tripId: req.tripId,
    actor: caller.userId,
    aal2: caller.aal2,
    deviceId: caller.deviceId ?? null,
    to: req.to,
    openItems: ops.openItems.map((i) => ({ ref: i.ref, kind: i.kind, detail: i.detail })),
    assignments: req.assignments ?? [],
    reason: req.reason ?? null,
  });
  return { state: t.state, openItems: ops.openItems };
}

/** Prices map for the engine from price list rows. */
export function pricesFrom(rows: { product_id: string; unit_price_minor: number | string; currency: string }[]) {
  return Object.fromEntries(
    rows.map((r) => [r.product_id, { currency: r.currency, minor: Number(r.unit_price_minor) } as Money]),
  );
}
