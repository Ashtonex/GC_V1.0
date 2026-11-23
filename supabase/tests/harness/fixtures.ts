/**
 * Test organisation for database tests. Section 6 TEST CONSTANTS ONLY (prices, costs, FX 27.00 "TEST").
 * Never used against production (Section 7).
 */
import { randomUUID } from 'node:crypto';
import type { TripEvent } from '@gc/schema';
import { COSTS, PRICES, TEST_RATE, asDeviceEvents } from '../../../packages/engine/src/fixtures/section6.ts';
import type { Session, TestDb } from './db.ts';

/** Stable fixture name → UUID map (engine fixtures use readable ids; the API requires UUIDs). */
export class Ids {
  private byName = new Map<string, string>();
  private byId = new Map<string, string>();
  constructor(private readonly parent?: Ids) {}
  /** A fresh namespace for one trip's event ids that still resolves shared names (people, products, customers). */
  child(): Ids {
    return new Ids(this);
  }
  private find(name: string): string | undefined {
    return this.byName.get(name) ?? this.parent?.find(name);
  }
  of(name: string): string {
    let id = this.find(name);
    if (!id) {
      id = randomUUID();
      this.byName.set(name, id);
      this.byId.set(id, name);
    }
    return id;
  }
  set(name: string, id: string): void {
    this.byName.set(name, id);
    this.byId.set(id, name);
  }
  nameOf(id: string): string | undefined {
    return this.byId.get(id) ?? this.parent?.nameOf(id);
  }
}

export const PEOPLE = {
  owner: 'O1',
  accounts: 'A1',
  accounts2: 'A2',
  warehouse: 'W1',
  driver: 'D1',
  driver2: 'D2',
  /** One person with Driver + Accounts roles (D-027). */
  mixed: 'M1',
} as const;

export interface World {
  ids: Ids;
  org: string;
  truck: string;
  truck2: string;
  priceList: string;
  /** Sessions: drivers on their registered phone. */
  s: Record<keyof typeof PEOPLE, Session>;
  user: Record<keyof typeof PEOPLE, string>;
  devices: { driver: string; driver2: string; mixedPhone: string };
}

const ROLES_OF: Record<keyof typeof PEOPLE, string[]> = {
  owner: ['owner'],
  accounts: ['accounts'],
  accounts2: ['accounts'],
  warehouse: ['warehouse'],
  driver: ['driver'],
  driver2: ['driver'],
  mixed: ['driver', 'accounts'],
};

export async function seedWorld(db: TestDb): Promise<World> {
  const ids = new Ids();
  const org = randomUUID();
  await db.admin(`insert into public.organizations (id, name) values ($1, 'GC Test Org')`, [org]);
  await db.admin(`insert into public.org_settings (org_id) values ($1)`, [org]);

  const user = {} as World['user'];
  for (const [key, name] of Object.entries(PEOPLE) as [keyof typeof PEOPLE, string][]) {
    const id = randomUUID();
    ids.set(name, id);
    user[key] = id;
    await db.admin(`insert into auth.users (id, email) values ($1, $2)`, [id, `${name.toLowerCase()}@test.invalid`]);
    await db.admin(`insert into public.profiles (user_id, org_id, display_name) values ($1, $2, $3)`, [id, org, name]);
    for (const role of ROLES_OF[key]) {
      await db.admin(`insert into public.user_roles (user_id, role) values ($1, $2)`, [id, role]);
    }
  }

  const devices = { driver: randomUUID(), driver2: randomUUID(), mixedPhone: randomUUID() };
  for (const [dev, who] of [
    [devices.driver, user.driver],
    [devices.driver2, user.driver2],
    [devices.mixedPhone, user.mixed],
  ] as const) {
    await db.admin(`insert into public.devices (id, org_id, user_id, kind) values ($1, $2, $3, 'driver_phone')`, [
      dev,
      org,
      who,
    ]);
  }

  const truck = randomUUID();
  const truck2 = randomUUID();
  await db.admin(
    `insert into public.trucks (id, org_id, registration) values ($1, $2, 'TEST-001'), ($3, $2, 'TEST-002')`,
    [truck, org, truck2],
  );
  const priceList = randomUUID();
  await db.admin(`insert into public.price_lists (id, org_id, name, currency) values ($1, $2, 'Test list', 'USD')`, [
    priceList,
    org,
  ]);
  for (const sku of ['P1', 'P2', 'P3']) {
    const pid = ids.of(sku);
    await db.admin(
      `insert into public.products (id, org_id, sku, name, base_unit, pack_size) values ($1, $2, $3, $3, 'case', 1)`,
      [pid, org, sku],
    );
    await db.admin(
      `insert into public.price_list_items (price_list_id, product_id, unit_price_minor) values ($1, $2, $3)`,
      [priceList, pid, PRICES[sku]!.minor],
    );
    await db.admin(
      `insert into public.product_costs (org_id, product_id, unit_cost_minor, currency, effective_from, entered_by)
       values ($1, $2, $3, 'USD', '2026-01-01T00:00:00Z', $4)`,
      [org, pid, COSTS[sku]!.minor, user.accounts],
    );
  }
  for (const [name, creditLimit] of [
    ['cust-A', null],
    ['cust-B', 10000],
    ['cust-D', null],
    ['cust-E', 50000],
  ] as const) {
    await db.admin(
      `insert into public.customers (id, org_id, name, phone, credit_limit_minor) values ($1, $2, $3, $4, $5)`,
      [ids.of(name), org, name, `+263 77 000 ${name.slice(-1).charCodeAt(0)}`, creditLimit],
    );
  }
  await db.admin(
    `insert into public.exchange_rates (org_id, from_ccy, to_ccy, rate_decimal, source, effective_at, entered_by)
     values ($1, 'USD', 'ZWG', $2, $3, $4, $5)`,
    [org, TEST_RATE.rate, TEST_RATE.source, TEST_RATE.effectiveAt, user.accounts],
  );
  // Test value: Accounts may approve expenses up to USD 100.00. The live limit is an Owner decision (M6).
  await db.admin(
    `insert into public.expense_approval_limits (org_id, currency, max_minor, set_by) values ($1, 'USD', 10000, $2)`,
    [org, user.owner],
  );

  const s = Object.fromEntries(
    (Object.keys(PEOPLE) as (keyof typeof PEOPLE)[]).map((k) => [k, { userId: user[k] } as Session]),
  ) as World['s'];
  s.driver = { userId: user.driver, deviceId: devices.driver };
  s.driver2 = { userId: user.driver2, deviceId: devices.driver2 };
  return { ids, org, truck, truck2, priceList, s, user, devices };
}

/** Plan a DRAFT trip for driver D1 on truck 1 (as Accounts) and return its id. */
export async function planTrip(db: TestDb, w: World, opts: { truck?: string; driver?: string } = {}): Promise<string> {
  const id = randomUUID();
  await db.as(
    w.s.accounts,
    `insert into public.trips (id, org_id, truck_id, driver_id, price_list_id, planned_date, created_by)
     values ($1, $2, $3, $4, $5, '2026-11-23', $6)`,
    [id, w.org, opts.truck ?? w.truck, opts.driver ?? w.user.driver, w.priceList, w.user.accounts],
  );
  return id;
}

export async function setState(db: TestDb, s: Session, trip: string, to: string): Promise<void> {
  await db.as(s, `select public.set_trip_state($1, $2::gc.trip_state)`, [trip, to]);
}

/** Force a trip into a state for a focused test (setup only, as the DB owner). */
export async function forceState(db: TestDb, trip: string, state: string): Promise<void> {
  await db.admin(`update public.trips set state = $2::gc.trip_state where id = $1`, [trip, state]);
}

export interface IngestOut {
  batch: string;
  clockSkew: boolean;
  results: { id: string | null; status: string; error?: string }[];
}

export async function ingest(
  db: TestDb,
  s: Session,
  events: unknown[],
  opts: { sentAt?: string; rejections?: Record<string, string> } = {},
): Promise<IngestOut> {
  const batch = {
    ...(s.deviceId ? { deviceId: s.deviceId } : {}),
    sentAt: opts.sentAt ?? new Date().toISOString(),
    events,
  };
  const [row] = await db.as<{ r: IngestOut }>(s, `select public.ingest_events($1::jsonb, $2::jsonb) as r`, [
    JSON.stringify(batch),
    JSON.stringify(opts.rejections ?? {}),
  ]);
  return row!.r;
}

const ID_KEYS = new Set([
  'id',
  'tripId',
  'actorId',
  'handoverId',
  'issuerId',
  'receiverId',
  'productId',
  'saleId',
  'customerId',
  'lineId',
  'paymentId',
  'collectionId',
  'expenseId',
  'reversesEventId',
]);

/** Engine fixture events (readable ids, server-side costs) → what a client sends (UUIDs, no costs). */
export function toApiEvents(events: TripEvent[], ids: Ids, tripId: string): TripEvent[] {
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    if (typeof v === 'string' && key && ID_KEYS.has(key)) return key === 'tripId' ? tripId : ids.of(v);
    return v;
  };
  return asDeviceEvents(events).map((e) => walk(e) as TripEvent);
}

/** Replace every known UUID in a value with its fixture name (to compare with the pure engine run). */
export function toNames<T>(value: T, ids: Ids, tripId: string, tripName: string): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [ids.nameOf(k) ?? k, walk(x)]));
    }
    if (typeof v === 'string') return v === tripId ? tripName : (ids.nameOf(v) ?? v);
    return v;
  };
  return walk(value) as T;
}
