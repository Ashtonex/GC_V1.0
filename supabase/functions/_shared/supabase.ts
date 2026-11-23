/**
 * Deno-side wiring (Supabase Edge Runtime): builds the Caller from the verified JWT and the Gateway from
 * supabase-js. Not unit-tested in Node (handlers.ts is); verified with `supabase functions serve` (see STATE.md).
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { IngestResponse, Role, TripEvent } from '@gc/schema';
import { HttpError, pricesFrom, type Caller, type Gateway } from './handlers.ts';

declare const Deno: { env: { get(k: string): string | undefined } };

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

function jwtClaims(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1] ?? '';
  return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
}

export interface Context {
  caller: Caller;
  gateway: Gateway;
}

export async function contextFrom(req: Request): Promise<Context> {
  const auth = req.headers.get('Authorization') ?? '';
  const jwt = auth.replace(/^Bearer\s+/i, '');
  if (!jwt) throw new HttpError(401, 'sign in required');
  const deviceId = req.headers.get('x-gc-device-id') ?? undefined;
  const headers: Record<string, string> = { Authorization: auth, ...(deviceId ? { 'x-gc-device-id': deviceId } : {}) };
  const user: SupabaseClient = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers } });
  const service: SupabaseClient = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

  const { data: u, error } = await user.auth.getUser(jwt);
  if (error || !u.user) throw new HttpError(401, 'invalid or expired session');
  const claims = jwtClaims(jwt); // signature already verified by getUser
  const { data: roleRows } = await user.from('user_roles').select('role').eq('user_id', u.user.id);
  const { data: dev } = deviceId
    ? await user.from('devices').select('id, kind').eq('id', deviceId).eq('user_id', u.user.id).maybeSingle()
    : { data: null };

  const caller: Caller = {
    userId: u.user.id,
    roles: (roleRows ?? []).map((r: { role: Role }) => r.role),
    aal2: claims.aal === 'aal2',
    ...(deviceId ? { deviceId } : {}),
    driverDevice: dev?.kind === 'driver_phone',
  };

  const gateway: Gateway = {
    async ingest(batch, rejections) {
      const { data, error: e } = await user.rpc('ingest_events', { p_batch: batch, p_rejections: rejections });
      if (e) throw new HttpError(400, e.message);
      return data as IngestResponse;
    },
    async loadTrip(tripId) {
      const { data: trip, error: e1 } = await service
        .from('trips')
        .select('id, price_list_id')
        .eq('id', tripId)
        .single();
      if (e1 || !trip) throw new HttpError(404, 'unknown trip');
      const { data: ev } = await service.from('trip_events').select('payload').eq('trip_id', tripId).order('seq');
      const { data: list } = await service.from('price_lists').select('currency').eq('id', trip.price_list_id).single();
      const { data: items } = await service
        .from('price_list_items')
        .select('product_id, unit_price_minor')
        .eq('price_list_id', trip.price_list_id);
      const currency = (list?.currency ?? 'USD') as 'USD';
      return {
        events: (ev ?? []).map((r: { payload: TripEvent }) => r.payload),
        ctx: {
          currency,
          prices: pricesFrom((items ?? []).map((i: Record<string, unknown>) => ({ ...i, currency }) as never)),
        },
      };
    },
    async closeTrip(a) {
      const { data, error: e } = await service.rpc('close_trip', {
        p_trip_id: a.tripId,
        p_actor: a.actor,
        p_aal2: a.aal2,
        p_device: a.deviceId,
        p_to: a.to,
        p_open_items: a.openItems,
        p_assignments: a.assignments,
        p_reason: a.reason,
      });
      if (e) throw new HttpError(409, e.message);
      return data as { state: string };
    },
  };
  return { caller, gateway };
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-gc-device-id',
};

/** Wraps a handler: CORS, JSON in/out, HttpError → status. */
export function serve(handler: (body: unknown, ctx: Context) => Promise<unknown>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'POST only');
      const ctx = await contextFrom(req);
      const out = await handler(await req.json(), ctx);
      return Response.json(out, { headers: cors });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : 'internal error';
      return Response.json({ error: message }, { status, headers: cors });
    }
  };
}
